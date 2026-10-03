package main

// 初選（Shortlist，ADR-0010）：candidates ─表決過半→ shortlisting ─房主開始投票→ voting。
// 寫入都在 Go 房間交易內（service role），先鎖 rooms 再碰成員與表決／圈選表，
// 鎖序與改地點表決、餐廳投票、退房一致。

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

const (
	ShortlistPickMin       = 3 // 全員都圈滿這個數，房主才能開始投票
	ShortlistPickMax       = 5
	ShortlistGatePerMember = 3 // 可抽候選 > 成員數 × 3 才開放初選表決
)

// shortlistRejected：可預期的業務拒絕，原文回給使用者
type shortlistRejected string

func (e shortlistRejected) Error() string { return string(e) }

func shortlistError(w http.ResponseWriter, err error) {
	var rejected shortlistRejected
	switch {
	case errors.As(err, &rejected):
		jsonError(w, http.StatusConflict, string(rejected))
	case errors.Is(err, ErrNotHost):
		jsonError(w, http.StatusForbidden, "只有房主可以執行此操作")
	case errors.Is(err, ErrNotMember):
		jsonError(w, http.StatusForbidden, "你不是這個房間的成員")
	case errors.Is(err, ErrConflict), errors.Is(err, pgx.ErrNoRows):
		jsonError(w, http.StatusConflict, "房間狀態已更新，請重新整理")
	default:
		log.Printf("shortlist: %v", err)
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
	}
}

// keptPicksSQL：某成員目前仍可抽（kept）的圈選數；被退房重算排除的店不算數
const keptPicksSQL = `select count(*) from shortlist_picks p join room_candidates c
	on c.room_id=p.room_id and c.restaurant_id=p.restaurant_id and c.status='kept'
	where p.room_id=$1 and p.user_id=$2`

// lockRoomForMember：鎖房間並確認成員；version 不是目前搜尋輪次（search_version）即 ErrConflict，
// 同改地點表決，擋下上一輪畫面送來的請求
func lockRoomForMember(ctx context.Context, tx pgx.Tx, roomID, uid string, version int64) (string, error) {
	var status string
	var current int64
	if err := tx.QueryRow(ctx, `select status, search_version from rooms where id=$1 for update`,
		roomID).Scan(&status, &current); err != nil {
		return "", err
	}
	var member bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from room_members where room_id=$1 and user_id=$2)`,
		roomID, uid).Scan(&member); err != nil {
		return "", err
	}
	if !member {
		return "", ErrNotMember
	}
	if current != version {
		return "", ErrConflict
	}
	return status, nil
}

// passShortlistMajority：呼叫端持有 room lock。過半當下重驗門檻——退房會改變成員數與候選。
func passShortlistMajority(ctx context.Context, tx pgx.Tx, roomID string) (bool, error) {
	var passed bool
	err := tx.QueryRow(ctx, `with counts as (
		select count(*) members, count(v.user_id) yes
		from room_members m left join shortlist_votes v
		on v.room_id=m.room_id and v.user_id=m.user_id where m.room_id=$1
	), kept as (
		select count(*) n from room_candidates where room_id=$1 and status='kept'
	), changed as (
		update rooms set status='shortlisting' from counts, kept
		where rooms.id=$1 and rooms.status='candidates'
			and counts.yes > counts.members/2 and kept.n > counts.members*$2
		returning rooms.id
	) select exists(select 1 from changed)`, roomID, ShortlistGatePerMember).Scan(&passed)
	return passed, err
}

func handleShortlistVote(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	var req struct {
		Want    *bool  `json:"want"`
		Version *int64 `json:"version"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.Want == nil || req.Version == nil || *req.Version < 0 {
		jsonError(w, http.StatusBadRequest, "初選表決格式不正確")
		return
	}
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return
	}
	ctx, uid := r.Context(), UserID(r)
	var status string
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		var err error
		if status, err = lockRoomForMember(ctx, tx, roomID, uid, *req.Version); err != nil {
			return err
		}
		if status != "candidates" {
			return shortlistRejected("初選表決只在候選出爐時開放")
		}
		if !*req.Want {
			_, err = tx.Exec(ctx, `delete from shortlist_votes where room_id=$1 and user_id=$2`, roomID, uid)
			return err
		}
		var open bool
		if err := tx.QueryRow(ctx, `select
			(select count(*) from room_candidates where room_id=$1 and status='kept') >
			(select count(*) from room_members where room_id=$1) * $2`, roomID, ShortlistGatePerMember).Scan(&open); err != nil {
			return err
		}
		if !open {
			return shortlistRejected(fmt.Sprintf("候選沒有超過成員數的 %d 倍，不需要初選", ShortlistGatePerMember))
		}
		if _, err := tx.Exec(ctx, `insert into shortlist_votes(room_id,user_id) values($1,$2) on conflict do nothing`,
			roomID, uid); err != nil {
			return err
		}
		passed, err := passShortlistMajority(ctx, tx, roomID)
		if passed {
			status = "shortlisting"
		}
		return err
	})
	if err != nil {
		shortlistError(w, err)
		return
	}
	jsonOK(w, map[string]string{"status": status})
}

func handlePick(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	var req struct {
		RestaurantID string `json:"restaurant_id"`
		Op           string `json:"op"`
		Version      *int64 `json:"version"`
	}
	var parsed pgtype.UUID
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&req) != nil || (req.Op != "cast" && req.Op != "retract") ||
		req.Version == nil || *req.Version < 0 || parsed.Scan(req.RestaurantID) != nil {
		jsonError(w, http.StatusBadRequest, "圈選格式不正確")
		return
	}
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return
	}
	ctx, uid := r.Context(), UserID(r)
	var picks int
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		status, err := lockRoomForMember(ctx, tx, roomID, uid, *req.Version)
		if err != nil {
			return err
		}
		if status != "shortlisting" {
			return shortlistRejected("目前不在初選階段")
		}
		if req.Op == "retract" {
			if _, err := tx.Exec(ctx, `delete from shortlist_picks where room_id=$1 and user_id=$2 and restaurant_id=$3`,
				roomID, uid, req.RestaurantID); err != nil {
				return err
			}
			return tx.QueryRow(ctx, keptPicksSQL, roomID, uid).Scan(&picks)
		}
		var kept, already bool
		if err := tx.QueryRow(ctx, `select
			exists(select 1 from room_candidates where room_id=$1 and restaurant_id=$3 and status='kept'),
			exists(select 1 from shortlist_picks where room_id=$1 and user_id=$2 and restaurant_id=$3)`,
			roomID, uid, req.RestaurantID).Scan(&kept, &already); err != nil {
			return err
		}
		if !kept {
			return shortlistRejected("這家店不在候選中")
		}
		if err := tx.QueryRow(ctx, keptPicksSQL, roomID, uid).Scan(&picks); err != nil {
			return err
		}
		if already {
			return nil // 冪等：重送不佔額度
		}
		if picks >= ShortlistPickMax {
			return shortlistRejected(fmt.Sprintf("每人最多圈選 %d 家", ShortlistPickMax))
		}
		_, err = tx.Exec(ctx, `insert into shortlist_picks(room_id,user_id,restaurant_id) values($1,$2,$3)`,
			roomID, uid, req.RestaurantID)
		picks++
		return err
	})
	if err != nil {
		shortlistError(w, err)
		return
	}
	jsonOK(w, map[string]int{"picks": picks})
}

// handleCancelShortlist：房主取消初選回到候選出爐，圈選與表決全數作廢（不留下落選）
func handleCancelShortlist(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	ctx := r.Context()
	err := pgx.BeginFunc(ctx, pool, func(tx pgx.Tx) error {
		if err := assertHostInTx(ctx, tx, room.ID, UserID(r)); err != nil {
			return err
		}
		if err := TransitionRoom(ctx, tx, room.ID, "shortlisting", "candidates"); err != nil {
			return err
		}
		for _, q := range []string{`delete from shortlist_picks where room_id=$1`, `delete from shortlist_votes where room_id=$1`} {
			if _, err := tx.Exec(ctx, q, room.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		shortlistError(w, err)
		return
	}
	jsonOK(w, map[string]string{"status": "candidates"})
}

// freezeShortlist：開始投票時定案落選名單（ADR-0010）。前置：呼叫端持有 room lock，
// 房間剛從 shortlisting 轉出；之後由呼叫端重算，讓落選旗標進到 kept/excluded 分割。
// 退房者的圈選已隨 room_members cascade 消失，這裡看到的就是現任成員的圈選。
func freezeShortlist(ctx context.Context, tx pgx.Tx, roomID string) error {
	var unfinished int
	if err := tx.QueryRow(ctx, `select count(*) from room_members m where m.room_id=$1 and (
		select count(*) from shortlist_picks p join room_candidates c
			on c.room_id=p.room_id and c.restaurant_id=p.restaurant_id and c.status='kept'
		where p.room_id=m.room_id and p.user_id=m.user_id) < $2`, roomID, ShortlistPickMin).Scan(&unfinished); err != nil {
		return err
	}
	if unfinished > 0 {
		return shortlistRejected(fmt.Sprintf("還有 %d 位成員沒圈滿 %d 家", unfinished, ShortlistPickMin))
	}
	_, err := tx.Exec(ctx, `update room_candidates c set shortlist_excluded = true
		where c.room_id=$1 and not exists (select 1 from shortlist_picks p
			where p.room_id=c.room_id and p.restaurant_id=c.restaurant_id)`, roomID)
	return err
}

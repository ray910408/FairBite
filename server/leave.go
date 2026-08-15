package main

// 退房（Leave，ADR-0007）：回首頁即離席。刪票屬 vote 集中寫入路徑（ADR-0003）、
// host_id 屬 rooms 敏感欄位（0001 系統連線限定），因此走 Go service role，
// 不開 SQL definer 旁路。

import (
	"context"
	"errors"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// handleLeave：POST /api/leave — 退掉呼叫者的所有 membership（正常一間；
// 關分頁殘留的舊房下次進首頁一併自癒）。冪等：無 membership 回 200。
func handleLeave(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, weather WeatherProvider) {
	ctx := r.Context()
	uid := UserID(r)
	rows, err := pool.Query(ctx, `select room_id from room_members where user_id = $1`, uid)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	var roomIDs []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
			return
		}
		roomIDs = append(roomIDs, id)
	}
	rows.Close()
	if rows.Err() != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	for _, roomID := range roomIDs {
		if err := leaveOneRoom(ctx, pool, weather, roomID, uid); err != nil {
			log.Printf("leave room %s failed: %v", roomID, err)
			jsonError(w, http.StatusInternalServerError, "退出房間失敗，請稍後再試")
			return
		}
	}
	jsonOK(w, map[string]bool{"ok": true})
}

// leaveOneRoom：單房退出交易（ADR-0007）。
//
//	POST /api/leave（每房一交易）
//	     │
//	     ▼
//	select rooms ... for update ── ErrNoRows ──▶ commit（並發已刪房：冪等）
//	     │
//	     ├─ delete votes（退出者意見即刻作廢，ADR-0003 集中寫入）
//	     ├─ delete room_members ── 0 列 ──▶ commit（並發已退：冪等）
//	     ▼
//	查剩餘成員（joined_at, user_id 排序）
//	     ├─ 無人 ──▶ delete rooms（cascade；dining_history.room_id set null）──▶ commit
//	     ├─ 有人且我是 host ──▶ update host_id = 最早加入者（繼任）
//	     ▼
//	status ∈ {candidates, voting} ──▶ rescoreRoom（以現任成員重新分割 kept/excluded：
//	     ▼                            否決隱性收回、離席者硬排除一併解除——ADR-0007 修訂語意）
//	commit
//
// 檢索集不回擴：搜尋未抓回的店永遠不會出現（重擴檢索等同重搜，違反一房一搜）。
func leaveOneRoom(ctx context.Context, pool *pgxpool.Pool, weather WeatherProvider, roomID, uid string) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	var room RoomRow
	err = tx.QueryRow(ctx, `
		select id, host_id, status, coalesce(center_lat, 0), coalesce(center_lng, 0),
		       exploration, meal_time, cuisine_filter
		from rooms where id = $1 for update`, roomID).
		Scan(&room.ID, &room.HostID, &room.Status, &room.CenterLat, &room.CenterLng,
			&room.Exploration, &room.MealTime, &room.CuisineFilter)
	if errors.Is(err, pgx.ErrNoRows) {
		return nil // 並發退房已刪房：冪等
	}
	if err != nil {
		return err
	}
	if _, err := tx.Exec(ctx,
		`delete from votes where room_id = $1 and user_id = $2`, roomID, uid); err != nil {
		return err
	}
	tag, err := tx.Exec(ctx,
		`delete from room_members where room_id = $1 and user_id = $2`, roomID, uid)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return tx.Commit(ctx) // 並發已退：冪等
	}
	var successor string
	err = tx.QueryRow(ctx, `
		select user_id from room_members where room_id = $1
		order by joined_at, user_id limit 1`, roomID).Scan(&successor)
	if errors.Is(err, pgx.ErrNoRows) {
		// 末位退房：刪房（candidates/draws/殘票 cascade；dining_history.room_id set null）
		if _, err := tx.Exec(ctx, `delete from rooms where id = $1`, roomID); err != nil {
			return err
		}
		return tx.Commit(ctx)
	}
	if err != nil {
		return err
	}
	if room.HostID == uid {
		if _, err := tx.Exec(ctx,
			`update rooms set host_id = $2 where id = $1`, roomID, successor); err != nil {
			return err
		}
	}
	if room.Status == "candidates" || room.Status == "voting" {
		wx := loadWeatherCached(weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
		if _, _, err := rescoreRoom(ctx, tx, room, wx); err != nil {
			return err
		}
	}
	return tx.Commit(ctx)
}

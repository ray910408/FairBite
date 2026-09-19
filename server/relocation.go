package main

import (
	"context"
	"encoding/json"
	"errors"
	"math"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

// Caller owns the room lock, shared with restaurant voting, drawing and leaving.
func passLocationMajority(ctx context.Context, tx pgx.Tx, roomID string) (bool, error) {
	var passed bool
	err := tx.QueryRow(ctx, `with counts as (
		select count(*) members, count(v.user_id) yes
		from room_members m left join location_change_votes v
		on v.room_id=m.room_id and v.user_id=m.user_id where m.room_id=$1
	), changed as (
		update rooms set status='relocating' from counts
		where rooms.id=$1 and rooms.status='voting' and counts.yes > counts.members/2
		returning rooms.id
	) select exists(select 1 from changed)`, roomID).Scan(&passed)
	return passed, err
}

func handleLocationVote(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	var req struct {
		Want    *bool  `json:"want"`
		Version *int64 `json:"version"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.Want == nil || req.Version == nil || *req.Version < 0 {
		jsonError(w, http.StatusBadRequest, "改地點意願格式不正確")
		return
	}
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		pendingError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	var status string
	var version int64
	if err := tx.QueryRow(ctx, `select status, search_version from rooms where id=$1 for update`, roomID).Scan(&status, &version); err != nil {
		pendingError(w, err)
		return
	}
	var member bool
	if err := tx.QueryRow(ctx, `select exists(select 1 from room_members where room_id=$1 and user_id=$2)`, roomID, UserID(r)).Scan(&member); err != nil {
		pendingError(w, err)
		return
	}
	if !member {
		jsonError(w, http.StatusForbidden, "只有房間成員可以表決")
		return
	}
	if status != "voting" || version != *req.Version {
		jsonError(w, http.StatusConflict, "房間狀態已更新")
		return
	}
	if *req.Want {
		_, err = tx.Exec(ctx, `insert into location_change_votes(room_id,user_id) values($1,$2) on conflict do nothing`, roomID, UserID(r))
	} else {
		_, err = tx.Exec(ctx, `delete from location_change_votes where room_id=$1 and user_id=$2`, roomID, UserID(r))
	}
	if err != nil {
		pendingError(w, err)
		return
	}
	passed, err := passLocationMajority(ctx, tx, roomID)
	if err != nil {
		pendingError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		pendingError(w, err)
		return
	}
	if passed {
		status = "relocating"
	}
	jsonOK(w, map[string]any{"status": status})
}

func handleChooseLocation(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	var req struct {
		Lat     *float64 `json:"lat"`
		Lng     *float64 `json:"lng"`
		Version *int64   `json:"version"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1024)
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.Lat == nil || req.Lng == nil || req.Version == nil ||
		*req.Version < 0 || math.IsNaN(*req.Lat) || math.IsNaN(*req.Lng) || math.IsInf(*req.Lat, 0) || math.IsInf(*req.Lng, 0) ||
		*req.Lat < -90 || *req.Lat > 90 || *req.Lng < -180 || *req.Lng > 180 {
		jsonError(w, http.StatusBadRequest, "出發點格式不正確")
		return
	}
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return
	}
	ctx := r.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		pendingError(w, err)
		return
	}
	defer tx.Rollback(ctx)
	var host, status string
	var version int64
	if err := tx.QueryRow(ctx, `select host_id,status,search_version from rooms where id=$1 for update`, roomID).Scan(&host, &status, &version); err != nil {
		pendingError(w, err)
		return
	}
	if host != UserID(r) {
		pendingError(w, ErrNotHost)
		return
	}
	if (status != "lobby" && status != "relocating") || version != *req.Version {
		pendingError(w, ErrConflict)
		return
	}
	if _, err := tx.Exec(ctx, `update rooms set center_lat=$2,center_lng=$3,status='lobby',search_version=search_version+1 where id=$1`, roomID, *req.Lat, *req.Lng); err != nil {
		pendingError(w, err)
		return
	}
	if err := clearLocationBatch(ctx, tx, roomID); err != nil {
		pendingError(w, err)
		return
	}
	if err := tx.Commit(ctx); err != nil {
		pendingError(w, err)
		return
	}
	jsonOK(w, map[string]any{"status": "lobby", "version": version + 1})
}

// Use only after the room has entered lobby, while holding its lock.
func clearLocationBatch(ctx context.Context, tx pgx.Tx, roomID string) error {
	for _, query := range []string{
		`delete from room_candidates where room_id=$1`,
		`delete from votes where room_id=$1`,
		`delete from location_change_votes where room_id=$1`,
		`update room_members set ready=false where room_id=$1`,
	} {
		if _, err := tx.Exec(ctx, query, roomID); err != nil {
			return err
		}
	}
	return nil
}

var ErrSearchChanged = errors.New("search location or round changed during search")

func checkSearchSnapshot(ctx context.Context, tx pgx.Tx, roomID string, version int64, lat, lng float64) error {
	var currentVersion int64
	var currentLat, currentLng float64
	if err := tx.QueryRow(ctx, `select search_version, center_lat, center_lng from rooms where id=$1`, roomID).
		Scan(&currentVersion, &currentLat, &currentLng); err != nil {
		return err
	}
	if currentVersion != version || currentLat != lat || currentLng != lng {
		return ErrSearchChanged
	}
	return nil
}

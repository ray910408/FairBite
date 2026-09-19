package main

import (
	"encoding/json"
	"errors"
	"log"
	"net/http"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type drawVersionCommand struct {
	Version int64 `json:"version"`
}

func decodeDrawVersion(w http.ResponseWriter, r *http.Request) (drawVersionCommand, bool) {
	var req drawVersionCommand
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if json.NewDecoder(r.Body).Decode(&req) != nil || req.Version < 1 {
		jsonError(w, http.StatusBadRequest, "抽選版本格式不正確")
		return req, false
	}
	return req, true
}

func resetExhaustedBatch(r *http.Request, tx pgx.Tx, roomID string) error {
	ctx := r.Context()
	if _, err := tx.Exec(ctx, `update rooms set status='lobby' where id=$1 and status='pending'`, roomID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `delete from room_candidates where room_id=$1`, roomID); err != nil {
		return err
	}
	if _, err := tx.Exec(ctx, `delete from votes where room_id=$1`, roomID); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `update room_members set ready=false where room_id=$1`, roomID)
	return err
}

func currentWinner(r *http.Request, tx pgx.Tx, roomID string, version int64) (string, error) {
	var winner string
	err := tx.QueryRow(r.Context(), `select winner_restaurant_id from draws
		where room_id=$1 and version=$2`, roomID, version).Scan(&winner)
	return winner, err
}

func lockPendingRoom(r *http.Request, tx pgx.Tx, roomID string, version int64) (RoomRow, error) {
	var room RoomRow
	err := tx.QueryRow(r.Context(), `select id, host_id, status, coalesce(center_lat,0), coalesce(center_lng,0),
		exploration, meal_time, cuisine_filter, draw_version, search_version from rooms where id=$1 for update`, roomID).
		Scan(&room.ID, &room.HostID, &room.Status, &room.CenterLat, &room.CenterLng,
			&room.Exploration, &room.MealTime, &room.CuisineFilter, &room.DrawVersion, &room.SearchVersion)
	if err != nil {
		return room, err
	}
	if room.HostID != UserID(r) {
		return room, ErrNotHost
	}
	if room.Status != "pending" || room.DrawVersion != version {
		return room, ErrConflict
	}
	return room, nil
}

func writePendingSnapshot(r *http.Request, tx pgx.Tx, room RoomRow, result EngineResult) (int64, string, error) {
	winner, seed := Draw(result.Kept)
	version := room.DrawVersion + 1
	probs := map[string]float64{}
	for _, c := range result.Kept {
		probs[c.Restaurant.ID] = c.Probability
	}
	if _, err := tx.Exec(r.Context(), `update rooms set draw_version=$2 where id=$1`, room.ID, version); err != nil {
		return 0, "", err
	}
	_, err := tx.Exec(r.Context(), `insert into draws(room_id,version,seed,winner_restaurant_id,probabilities)
		values($1,$2,$3,$4,$5)`, room.ID, version, seed, winner, probs)
	return version, winner, err
}

func pendingError(w http.ResponseWriter, err error) {
	switch {
	case errors.Is(err, ErrNotHost):
		jsonError(w, http.StatusForbidden, "只有房主可以執行此操作")
	case errors.Is(err, ErrConflict), errors.Is(err, pgx.ErrNoRows):
		jsonError(w, http.StatusConflict, "抽選結果已更新，請重新整理")
	default:
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
	}
}

func handleRedraw(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, weather WeatherProvider) {
	req, ok := decodeDrawVersion(w, r)
	if !ok {
		return
	}
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return
	}
	tx, err := pool.Begin(r.Context())
	if err != nil {
		pendingError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	room, err := lockPendingRoom(r, tx, roomID, req.Version)
	if err != nil {
		pendingError(w, err)
		return
	}
	winner, err := currentWinner(r, tx, room.ID, req.Version)
	if err != nil {
		pendingError(w, err)
		return
	}
	if _, err := tx.Exec(r.Context(), `update room_candidates set batch_excluded=true
		where room_id=$1 and restaurant_id=$2`, room.ID, winner); err != nil {
		pendingError(w, err)
		return
	}
	wx := loadWeatherCached(weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
	result, _, err := rescoreRoom(r.Context(), tx, room, wx)
	if err != nil {
		log.Printf("redraw rescore failed: %v", err)
		jsonError(w, 500, "重算失敗，請稍後再試")
		return
	}
	if len(result.Kept) == 0 {
		if err := resetExhaustedBatch(r, tx, room.ID); err != nil {
			pendingError(w, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			pendingError(w, err)
			return
		}
		jsonOK(w, map[string]any{"status": "lobby", "exhausted": true})
		return
	}
	version, next, err := writePendingSnapshot(r, tx, room, result)
	if err != nil {
		pendingError(w, err)
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		pendingError(w, err)
		return
	}
	jsonOK(w, map[string]any{"status": "pending", "version": version, "winner_restaurant_id": next})
}

func handleConfirmDraw(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, weather WeatherProvider) {
	req, ok := decodeDrawVersion(w, r)
	if !ok {
		return
	}
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return
	}
	// Idempotent retry after a successful commit: same host and same final version is already done.
	pre, err := LoadRoom(r.Context(), pool, roomID)
	if err == nil && pre.HostID == UserID(r) && pre.Status == "decided" && pre.DrawVersion == req.Version {
		jsonOK(w, map[string]any{"status": "decided", "version": req.Version})
		return
	}
	tx, err := pool.Begin(r.Context())
	if err != nil {
		pendingError(w, err)
		return
	}
	defer tx.Rollback(r.Context())
	room, err := lockPendingRoom(r, tx, roomID, req.Version)
	if err != nil {
		pendingError(w, err)
		return
	}
	winner, err := currentWinner(r, tx, room.ID, req.Version)
	if err != nil {
		pendingError(w, err)
		return
	}
	wx := loadWeatherCached(weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
	result, members, err := rescoreRoom(r.Context(), tx, room, wx)
	if err != nil {
		log.Printf("confirm rescore failed: %v", err)
		jsonError(w, 500, "重算失敗，請稍後再試")
		return
	}
	if len(result.Kept) == 0 {
		if err := resetExhaustedBatch(r, tx, room.ID); err != nil {
			pendingError(w, err)
			return
		}
		if err := tx.Commit(r.Context()); err != nil {
			pendingError(w, err)
			return
		}
		jsonError(w, http.StatusConflict, "候選已全數失效，請重新搜尋")
		return
	}
	var winnerRest Restaurant
	for _, c := range result.Kept {
		if c.Restaurant.ID == winner {
			winnerRest = c.Restaurant
			break
		}
	}
	if winnerRest.ID == "" {
		if err := tx.Commit(r.Context()); err != nil {
			pendingError(w, err)
			return
		}
		jsonError(w, http.StatusConflict, "這家餐廳已失效，請排除並重轉")
		return
	}
	if err := TransitionRoom(r.Context(), tx, room.ID, "pending", "decided"); err != nil {
		pendingError(w, err)
		return
	}
	if err := RecordDecision(r.Context(), tx, room.ID, members, winnerRest); err != nil {
		jsonError(w, 500, "寫入同席紀錄失敗")
		return
	}
	if err := tx.Commit(r.Context()); err != nil {
		pendingError(w, err)
		return
	}
	jsonOK(w, map[string]any{"status": "decided", "version": req.Version})
}

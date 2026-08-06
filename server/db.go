package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrConflict = errors.New("status conflict")

type RoomRow struct {
	ID        string
	HostID    string
	Status    string
	CenterLat float64
	CenterLng float64
}

func LoadRoom(ctx context.Context, pool *pgxpool.Pool, roomID string) (RoomRow, error) {
	var r RoomRow
	err := pool.QueryRow(ctx,
		`select id, host_id, status, coalesce(center_lat, 0), coalesce(center_lng, 0)
		 from rooms where id = $1`, roomID).
		Scan(&r.ID, &r.HostID, &r.Status, &r.CenterLat, &r.CenterLng)
	return r, err
}

func LoadMembers(ctx context.Context, pool *pgxpool.Pool, roomID string) ([]Member, error) {
	rows, err := pool.Query(ctx,
		`select rm.user_id, coalesce(nullif(p.display_name, ''), '成員'), rm.budget_max,
		        rm.cuisines, rm.dietary, rm.max_distance_m, rm.transport
		 from room_members rm join profiles p on p.id = rm.user_id
		 where rm.room_id = $1`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Member
	for rows.Next() {
		var m Member
		var cuisines, dietary []byte
		if err := rows.Scan(&m.UserID, &m.DisplayName, &m.BudgetMax, &cuisines, &dietary,
			&m.MaxDistanceM, &m.Transport); err != nil {
			return nil, err
		}
		// 信任邊界：JSON shape 異常是錯誤，不靜默當空值
		if err := json.Unmarshal(cuisines, &m.Cuisines); err != nil {
			return nil, fmt.Errorf("member %s cuisines: %w", m.UserID, err)
		}
		if err := json.Unmarshal(dietary, &m.Dietary); err != nil {
			return nil, fmt.Errorf("member %s dietary: %w", m.UserID, err)
		}
		out = append(out, m)
	}
	return out, rows.Err()
}

// UpsertRestaurants 寫入快取並回填 DB uuid 到 rs[i].ID
func UpsertRestaurants(ctx context.Context, tx pgx.Tx, rs []Restaurant) error {
	for i := range rs {
		tags, _ := json.Marshal(rs[i].CuisineTags)
		hours, _ := json.Marshal(rs[i].Hours)
		err := tx.QueryRow(ctx, `
			insert into restaurants (place_id, name, cuisine_tags, price_level, lat, lng, address, opening_hours, rating, fetched_at)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
			on conflict (place_id) do update set
			  name = excluded.name, cuisine_tags = excluded.cuisine_tags,
			  price_level = excluded.price_level, lat = excluded.lat, lng = excluded.lng,
			  address = excluded.address, opening_hours = excluded.opening_hours,
			  rating = excluded.rating, fetched_at = now()
			returning id`,
			rs[i].PlaceID, rs[i].Name, tags, rs[i].PriceLevel, rs[i].Lat, rs[i].Lng,
			rs[i].Address, hours, rs[i].Rating).Scan(&rs[i].ID)
		if err != nil {
			return fmt.Errorf("upsert %s: %w", rs[i].PlaceID, err)
		}
	}
	return nil
}

func ReplaceCandidates(ctx context.Context, tx pgx.Tx, roomID string, res EngineResult) error {
	if _, err := tx.Exec(ctx, `delete from room_candidates where room_id = $1`, roomID); err != nil {
		return err
	}
	for _, c := range res.Kept {
		trace, _ := json.Marshal(c.Trace)
		if _, err := tx.Exec(ctx, `
			insert into room_candidates (room_id, restaurant_id, status, probability, weight_breakdown)
			values ($1, $2, 'kept', $3, $4)`,
			roomID, c.Restaurant.ID, c.Probability, trace); err != nil {
			return err
		}
	}
	for _, e := range res.Excluded {
		if _, err := tx.Exec(ctx, `
			insert into room_candidates (room_id, restaurant_id, status, exclusion_reason)
			values ($1, $2, 'excluded', $3)`,
			roomID, e.Restaurant.ID, e.Reason); err != nil {
			return err
		}
	}
	return nil
}

func TransitionRoom(ctx context.Context, tx pgx.Tx, roomID, from, to string) error {
	tag, err := tx.Exec(ctx,
		`update rooms set status = $3 where id = $1 and status = $2`, roomID, from, to)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}

// LoadRoomRestaurants 取回該房搜尋時的完整餐廳集合（含被排除者）— 抽選前權威重算用
func LoadRoomRestaurants(ctx context.Context, pool *pgxpool.Pool, roomID string) ([]Restaurant, error) {
	rows, err := pool.Query(ctx, `
		select r.id, r.place_id, r.name, r.cuisine_tags, r.price_level,
		       r.lat, r.lng, r.address, r.opening_hours, coalesce(r.rating, 0)
		from room_candidates rc join restaurants r on r.id = rc.restaurant_id
		where rc.room_id = $1`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Restaurant
	for rows.Next() {
		var r Restaurant
		var tags, hours []byte
		if err := rows.Scan(&r.ID, &r.PlaceID, &r.Name, &tags, &r.PriceLevel,
			&r.Lat, &r.Lng, &r.Address, &hours, &r.Rating); err != nil {
			return nil, err
		}
		if err := json.Unmarshal(tags, &r.CuisineTags); err != nil {
			return nil, fmt.Errorf("restaurant %s tags: %w", r.PlaceID, err)
		}
		if err := json.Unmarshal(hours, &r.Hours); err != nil {
			return nil, fmt.Errorf("restaurant %s hours: %w", r.PlaceID, err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

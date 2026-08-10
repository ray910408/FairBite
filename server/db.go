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

// D2/D15：讀取函式吃 querier（*pgxpool.Pool 與 pgx.Tx 皆滿足），
// vote 交易才能在 room row lock 之後於 tx 內讀，杜絕 stale 讀寫競態
type querier interface {
	Query(ctx context.Context, sql string, args ...any) (pgx.Rows, error)
	QueryRow(ctx context.Context, sql string, args ...any) pgx.Row
}

type RoomRow struct {
	ID          string
	HostID      string
	Status      string
	CenterLat   float64
	CenterLng   float64
	Exploration string
}

func LoadRoom(ctx context.Context, pool *pgxpool.Pool, roomID string) (RoomRow, error) {
	var r RoomRow
	err := pool.QueryRow(ctx,
		`select id, host_id, status, coalesce(center_lat, 0), coalesce(center_lng, 0), exploration
		 from rooms where id = $1`, roomID).
		Scan(&r.ID, &r.HostID, &r.Status, &r.CenterLat, &r.CenterLng, &r.Exploration)
	return r, err
}

// user_id 排序是鎖順序 pin：room_members FOR UPDATE 與後續 exposure_stats upsert 都沿用。
const loadMembersSQL = `select rm.user_id, coalesce(nullif(p.display_name, ''), '成員'), rm.budget_max,
       rm.cuisines, rm.dietary, rm.max_distance_m, rm.transport
from room_members rm join profiles p on p.id = rm.user_id
where rm.room_id = $1
order by rm.user_id`

func LoadMembers(ctx context.Context, q querier, roomID string) ([]Member, error) {
	return loadMembers(ctx, q, roomID, loadMembersSQL)
}

func LoadMembersForUpdate(ctx context.Context, q querier, roomID string) ([]Member, error) {
	// TransitionRoom 已先鎖 rooms；再依 user_id 固定順序鎖 room_members，
	// 保證凍結快照與並發條件更新的原子性。
	return loadMembers(ctx, q, roomID, loadMembersSQL+"\nfor update of rm")
}

func loadMembers(ctx context.Context, q querier, roomID, query string) ([]Member, error) {
	rows, err := q.Query(ctx, query, roomID)
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

func memberIDs(ms []Member) []string {
	ids := make([]string, len(ms))
	for i, m := range ms {
		ids[i] = m.UserID
	}
	return ids
}

func LoadVotes(ctx context.Context, q querier, roomID string) (map[string]VoteInfo, error) {
	rows, err := q.Query(ctx,
		`select v.restaurant_id, v.kind, coalesce(nullif(p.display_name, ''), '成員')
		 from votes v join profiles p on p.id = v.user_id
		 where v.room_id = $1
		 order by v.created_at`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]VoteInfo{}
	for rows.Next() {
		var rid, kind, name string
		if err := rows.Scan(&rid, &kind, &name); err != nil {
			return nil, err
		}
		v := out[rid]
		if kind == "up" {
			v.Ups++
		} else {
			v.Vetoers = append(v.Vetoers, name)
		}
		out[rid] = v
	}
	return out, rows.Err()
}

// LoadRecency：每位成員對每家餐廳取「最近一次同席」，分 14 天內 / 15–30 天兩桶（spec §5 近期去過）
func LoadRecency(ctx context.Context, q querier, memberIDs, restaurantIDs []string) (map[string]RecencyCount, error) {
	rows, err := q.Query(ctx, `
		select restaurant_id,
		       count(*) filter (where last_at > now() - interval '14 days'),
		       count(*) filter (where last_at <= now() - interval '14 days')
		from (
			select restaurant_id, user_id, max(decided_at) as last_at
			from dining_history
			where user_id = any($1::uuid[]) and restaurant_id = any($2::uuid[])
			  and decided_at > now() - interval '30 days'
			group by 1, 2
		) t group by 1`, memberIDs, restaurantIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]RecencyCount{}
	for rows.Next() {
		var rid string
		var c RecencyCount
		if err := rows.Scan(&rid, &c.Fresh, &c.Fading); err != nil {
			return nil, err
		}
		out[rid] = c
	}
	return out, rows.Err()
}

// RecordExposure：搜尋成功時為「每位成員 × 每家 kept」+1（P3 曝光平衡的資料來源）
func RecordExposure(ctx context.Context, tx pgx.Tx, memberIDs, keptRestaurantIDs []string) error {
	_, err := tx.Exec(ctx, `
		insert into exposure_stats (user_id, restaurant_id, recommended_count)
		select u, r, 1 from unnest($1::uuid[]) u cross join unnest($2::uuid[]) r
		on conflict (user_id, restaurant_id) do update
		  set recommended_count = exposure_stats.recommended_count + 1`,
		memberIDs, keptRestaurantIDs)
	return err
}

// RecordDecision：房間 decided 時為每位成員寫一筆同席紀錄（ADR-0002）並更新 winner 曝光統計
func RecordDecision(ctx context.Context, tx pgx.Tx, roomID string, memberIDs []string, winnerID string) error {
	if _, err := tx.Exec(ctx, `
		insert into dining_history (user_id, restaurant_id, room_id)
		select u, $2, $1 from unnest($3::uuid[]) u
		on conflict (room_id, user_id) do nothing`,
		roomID, winnerID, memberIDs); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		insert into exposure_stats (user_id, restaurant_id, chosen_count, last_chosen_at)
		select u, $1, 1, now() from unnest($2::uuid[]) u
		on conflict (user_id, restaurant_id) do update
		  set chosen_count = exposure_stats.chosen_count + 1, last_chosen_at = now()`,
		winnerID, memberIDs)
	return err
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

// LoadCachedRestaurants：快取 fallback（spec §8）。只取 30 天內（快取條款：fetched_at 為準）。
// ponytail: 全量掃 + Go 端 haversine 過濾；快取量級小，夠用，量大再改 SQL bounding box
func LoadCachedRestaurants(ctx context.Context, pool *pgxpool.Pool, lat, lng float64, radiusM int, excludeMock bool) ([]Restaurant, error) {
	query := `
		select id, place_id, name, cuisine_tags, price_level, lat, lng, address, opening_hours, coalesce(rating, 0)
		from restaurants where fetched_at > now() - interval '30 days'`
	if excludeMock {
		query += ` and place_id not like 'mock-%'`
	}
	// Deterministic order pins exposure upsert lock order, matching the fresh-path sort.
	query += ` order by place_id`
	rows, err := pool.Query(ctx, query)
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
		if Haversine(lat, lng, r.Lat, r.Lng) <= float64(radiusM) {
			out = append(out, r)
		}
	}
	return out, rows.Err()
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
func LoadRoomRestaurants(ctx context.Context, q querier, roomID string) ([]Restaurant, error) {
	rows, err := q.Query(ctx, `
		select r.id, r.place_id, r.name, r.cuisine_tags, r.price_level,
		       r.lat, r.lng, r.address, r.opening_hours, coalesce(r.rating, 0)
		from room_candidates rc join restaurants r on r.id = rc.restaurant_id
		where rc.room_id = $1 order by rc.restaurant_id`, roomID)
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

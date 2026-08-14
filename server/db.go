package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

var ErrConflict = errors.New("status conflict")

// D2/D15：讀取函式吃 querier（*pgxpool.Pool 與 pgx.Tx 皆滿足），
// vote 交易才能在 room row lock 之後於 tx 內讀，杜絕 stale 讀寫競態
// 寫入函式（TransitionRoom/ReplaceCandidates/RecordExposure/RecordDecision/UpsertRestaurants）刻意吃 pgx.Tx——型別即「必須與呼叫端其他寫入同交易」的不變式，勿放寬成 querier。
type querier interface {
	Exec(ctx context.Context, sql string, arguments ...any) (pgconn.CommandTag, error)
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
	MealTime    *time.Time // NULL = 馬上出發（spec §4）
}

func LoadRoom(ctx context.Context, q querier, roomID string) (RoomRow, error) {
	var r RoomRow
	err := q.QueryRow(ctx,
		`select id, host_id, status, coalesce(center_lat, 0), coalesce(center_lng, 0), exploration, meal_time
		 from rooms where id = $1`, roomID).
		Scan(&r.ID, &r.HostID, &r.Status, &r.CenterLat, &r.CenterLng, &r.Exploration, &r.MealTime)
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

// LoadExposure：房內成員對每家餐廳的曝光聚合（P3 spec §5 曝光/新店因素）。
// handleSearch 必須在 RecordExposure 之前呼叫，否則本次搜尋的 +1
// 會讓「全員 recommended_count = 0」的新店判定永遠不成立。
func LoadExposure(ctx context.Context, q querier, memberIDs, restaurantIDs []string) (map[string]ExposureCount, error) {
	rows, err := q.Query(ctx, `
		select restaurant_id, sum(recommended_count)::int, sum(chosen_count)::int
		from exposure_stats
		where user_id = any($1::uuid[]) and restaurant_id = any($2::uuid[])
		group by 1`, memberIDs, restaurantIDs)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[string]ExposureCount{}
	for rows.Next() {
		var rid string
		var c ExposureCount
		if err := rows.Scan(&rid, &c.Recommended, &c.Chosen); err != nil {
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

// prefHit：中選餐廳對單一成員的偏好命中分（spec §5 滿足度樣本的估計值）。
// 沒設偏好 = 無訊號 → ok=false 不寫樣本（D22/OV#9：0.5 假中性會稀釋所有人的 EMA、
// 讓 FairnessMinGap 在預設狀態永不觸發——無訊號不得混充中性訊號；
// 這些成員的真訊號來源是餐後評分 rating）。
// 命中定義沿用 memberLikes（engine.go）——與偏好因素同源（eng review D11）。
func prefHit(m Member, r Restaurant) (float64, bool) {
	if len(m.Cuisines) == 0 {
		return 0, false
	}
	if memberLikes(m, r) {
		return 1, true
	}
	return 0, true
}

// RecordDecision：房間 decided 時為每位成員寫一筆同席紀錄（ADR-0002）並更新 winner 曝光統計。
// P3 起同時記下 pref_hit —— 滿足度樣本在成員跳過餐後評分時的後備值；空偏好寫 null。
func RecordDecision(ctx context.Context, tx pgx.Tx, roomID string, members []Member, winner Restaurant) error {
	ids := memberIDs(members)
	hits := make([]*float64, len(members)) // nil = 無樣本（D22）；pgx 編碼為 float8[] 的 NULL
	for i, m := range members {
		if v, ok := prefHit(m, winner); ok {
			hit := v
			hits[i] = &hit
		}
	}
	if _, err := tx.Exec(ctx, `
		insert into dining_history (user_id, restaurant_id, room_id, pref_hit)
		select u, $2, $1, h from unnest($3::uuid[], $4::float8[]) as t(u, h)
		on conflict (room_id, user_id) do nothing`,
		roomID, winner.ID, ids, hits); err != nil {
		return err
	}
	_, err := tx.Exec(ctx, `
		insert into exposure_stats (user_id, restaurant_id, chosen_count, last_chosen_at)
		select u, $1, 1, now() from unnest($2::uuid[]) u
		on conflict (user_id, restaurant_id) do update
		  set chosen_count = exposure_stats.chosen_count + 1, last_chosen_at = now()`,
		winner.ID, ids)
	return err
}

// LoadSatisfaction：每位成員取最近 EMASampleWindow 筆樣本（rating 優先、否則 pref_hit），
// 由舊到新折入 EMA。兩者皆缺的歷史列（0009 之前的資料）跳過。
// ponytail: window 掃無專屬索引（dining_history_recency 中段的 restaurant_id 用不上排序）；
// 個人量級夠用，量大加 (user_id, decided_at desc) 索引
func LoadSatisfaction(ctx context.Context, q querier, memberIDs []string) (map[string]float64, error) {
	// decided_at 可能同值；window 選樣本與 EMA 折入皆以 id 作穩定 tie-break。
	rows, err := q.Query(ctx, `
		select user_id, sample::float8 from (
			select user_id,
			       id,
			       coalesce((rating - 1) / 4.0, pref_hit) as sample,
			       decided_at,
			       row_number() over (partition by user_id order by decided_at desc, id desc) as rn
			from dining_history
			where user_id = any($1::uuid[])
			  and (rating is not null or pref_hit is not null)
		) t where rn <= $2
		order by user_id, decided_at, id`, memberIDs, EMASampleWindow)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	samples := map[string][]float64{}
	for rows.Next() {
		var uid string
		var s float64
		if err := rows.Scan(&uid, &s); err != nil {
			return nil, err
		}
		samples[uid] = append(samples[uid], s)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	out := map[string]float64{}
	for uid, ss := range samples {
		out[uid] = satisfactionEMA(ss)
	}
	return out, nil
}

// UpsertRestaurants 寫入快取並回填 DB uuid 到 rs[i].ID。
// source 是寫入 provider 的出身（PlacesProvider.Source）；conflict 時一併更新——
// 同一列被不同 provider 重抓時，provenance 跟著最新寫入者走。
func UpsertRestaurants(ctx context.Context, tx pgx.Tx, rs []Restaurant, source string) error {
	for i := range rs {
		// migration 0021 的 cuisine_tags CHECK 只接受字串陣列；nil slice 必須寫成 []，不能是 JSON null。
		if rs[i].CuisineTags == nil {
			rs[i].CuisineTags = []string{}
		}
		tags, _ := json.Marshal(rs[i].CuisineTags)
		hours, _ := json.Marshal(rs[i].Hours)
		err := tx.QueryRow(ctx, `
			insert into restaurants (place_id, name, primary_type, cuisine_tags, price_level, lat, lng, address, opening_hours, rating, source, fetched_at)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, now())
			on conflict (place_id) do update set
			  name = excluded.name, primary_type = excluded.primary_type, cuisine_tags = excluded.cuisine_tags,
			  price_level = excluded.price_level, lat = excluded.lat, lng = excluded.lng,
			  address = excluded.address, opening_hours = excluded.opening_hours,
			  rating = excluded.rating, source = excluded.source, fetched_at = now()
			returning id`,
			rs[i].PlaceID, rs[i].Name, rs[i].PrimaryType, tags, rs[i].PriceLevel, rs[i].Lat, rs[i].Lng,
			rs[i].Address, hours, rs[i].Rating, source).Scan(&rs[i].ID)
		if err != nil {
			return fmt.Errorf("upsert %s: %w", rs[i].PlaceID, err)
		}
	}
	return nil
}

// StaleOutRestaurants：歇業訊號只將既有 row 推出快取窗；不可 DELETE：舊房的 room_candidates 仍有 FK 參照。
func StaleOutRestaurants(ctx context.Context, q querier, placeIDs []string) error {
	if len(placeIDs) == 0 {
		return nil
	}
	_, err := q.Exec(ctx, `update restaurants set fetched_at = now() - interval '31 days' where place_id = any($1)`, placeIDs)
	return err
}

// LoadCachedRestaurants：快取 fallback（spec §8）。只取 30 天內（快取條款：fetched_at 為準）。
// excludeMock = 只接受 Google 出身的快取，故用正面表列 source = 'google'：
// 第三個 provider 進來時「不是 mock」不等於「是 google」。
// ponytail: 全量掃 + Go 端 haversine 過濾；快取量級小，夠用，量大再改 SQL bounding box
func LoadCachedRestaurants(ctx context.Context, q querier, lat, lng float64, radiusM int, excludeMock bool) ([]Restaurant, error) {
	query := `
		select id, place_id, name, primary_type, cuisine_tags, price_level, lat, lng, address, opening_hours, coalesce(rating, 0)
		from restaurants where fetched_at > now() - interval '30 days'`
	if excludeMock {
		query += ` and source = 'google'`
	}
	// Deterministic order pins exposure upsert lock order, matching the fresh-path sort.
	query += ` order by place_id`
	rows, err := q.Query(ctx, query)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Restaurant
	for rows.Next() {
		var r Restaurant
		var tags, hours []byte
		var primaryType pgtype.Text
		if err := rows.Scan(&r.ID, &r.PlaceID, &r.Name, &primaryType, &tags, &r.PriceLevel,
			&r.Lat, &r.Lng, &r.Address, &hours, &r.Rating); err != nil {
			return nil, err
		}
		// 升級前資料沒有 primary_type；未知資格一律 fail-closed。正常舊餐廳會在下次成功搜尋時重新入庫。
		if !primaryType.Valid || !gIsMealPrimaryType(primaryType.String) {
			continue
		}
		r.PrimaryType = primaryType.String
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

func ReplaceCandidates(ctx context.Context, tx pgx.Tx, roomID string, res EngineResult, exposureCounted map[string]bool) error {
	if _, err := tx.Exec(ctx, `delete from room_candidates where room_id = $1`, roomID); err != nil {
		return err
	}
	for _, c := range res.Kept {
		trace, _ := json.Marshal(c.Trace)
		if _, err := tx.Exec(ctx, `
			insert into room_candidates
				(room_id, restaurant_id, status, probability, weight_breakdown, exposure_counted)
			values ($1, $2, 'kept', $3, $4, $5)`,
			roomID, c.Restaurant.ID, c.Probability, trace, exposureCounted[c.Restaurant.ID]); err != nil {
			return err
		}
	}
	for _, e := range res.Excluded {
		// arch c3：結構化 kinds 隨列持久化（kept 列吃欄位 default '{}'）
		if _, err := tx.Exec(ctx, `
			insert into room_candidates
				(room_id, restaurant_id, status, exclusion_reason, exclusion_kinds, exposure_counted)
			values ($1, $2, 'excluded', $3, $4, $5)`,
			roomID, e.Restaurant.ID, e.Reason, nonNilKinds(e.Kinds), exposureCounted[e.Restaurant.ID]); err != nil {
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

// LoadRoomRestaurants 取回該房搜尋時的完整餐廳集合（含被排除者）及 search 曝光旗標— 抽選前權威重算用
func LoadRoomRestaurants(ctx context.Context, q querier, roomID string) ([]Restaurant, map[string]bool, error) {
	rows, err := q.Query(ctx, `
		select r.id, r.place_id, r.name, r.cuisine_tags, r.price_level,
		       r.lat, r.lng, r.address, r.opening_hours, coalesce(r.rating, 0), rc.exposure_counted
		from room_candidates rc join restaurants r on r.id = rc.restaurant_id
		where rc.room_id = $1 order by rc.restaurant_id`, roomID)
	if err != nil {
		return nil, nil, err
	}
	defer rows.Close()
	var out []Restaurant
	exposureCounted := map[string]bool{}
	for rows.Next() {
		var r Restaurant
		var tags, hours []byte
		var counted bool
		if err := rows.Scan(&r.ID, &r.PlaceID, &r.Name, &tags, &r.PriceLevel,
			&r.Lat, &r.Lng, &r.Address, &hours, &r.Rating, &counted); err != nil {
			return nil, nil, err
		}
		if err := json.Unmarshal(tags, &r.CuisineTags); err != nil {
			return nil, nil, fmt.Errorf("restaurant %s tags: %w", r.PlaceID, err)
		}
		if err := json.Unmarshal(hours, &r.Hours); err != nil {
			return nil, nil, fmt.Errorf("restaurant %s hours: %w", r.PlaceID, err)
		}
		out = append(out, r)
		exposureCounted[r.ID] = counted
	}
	if err := rows.Err(); err != nil {
		return nil, nil, err
	}
	return out, exposureCounted, nil
}

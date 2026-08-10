package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"sort"
	"sync"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
	"golang.org/x/time/rate"
)

type limiterStore struct {
	mu     sync.Mutex
	m      map[string]*rate.Limiter
	perSec rate.Limit
	burst  int
}

var searchInFlight sync.Map

func newLimiterStore(perSec rate.Limit, burst int) *limiterStore {
	return &limiterStore{m: map[string]*rate.Limiter{}, perSec: perSec, burst: burst}
}

// ponytail: map 無上限成長，P2 部署時加 TTL 清理
func (s *limiterStore) allow(uid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	l, ok := s.m[uid]
	if !ok {
		l = rate.NewLimiter(s.perSec, s.burst)
		s.m[uid] = l
	}
	return l.Allow()
}

func rateLimit(store *limiterStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !store.allow(UserID(r)) {
			jsonError(w, http.StatusTooManyRequests, "請求太頻繁，請稍後再試")
			return
		}
		next.ServeHTTP(w, r)
	})
}

func buildRoutes(v *Verifier, pool *pgxpool.Pool, places PlacesProvider, rl *limiterStore) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, map[string]bool{"ok": true})
	})
	api := http.NewServeMux()
	api.HandleFunc("POST /api/rooms/{id}/search", func(w http.ResponseWriter, r *http.Request) {
		handleSearch(w, r, pool, places)
	})
	api.HandleFunc("POST /api/rooms/{id}/start-voting", func(w http.ResponseWriter, r *http.Request) {
		handleStartVoting(w, r, pool)
	})
	api.HandleFunc("POST /api/rooms/{id}/vote", func(w http.ResponseWriter, r *http.Request) {
		handleVote(w, r, pool)
	})
	api.HandleFunc("POST /api/rooms/{id}/draw", func(w http.ResponseWriter, r *http.Request) {
		handleDraw(w, r, pool)
	})
	mux.Handle("/api/", v.Middleware(rateLimit(rl, api)))
	return cors(mux)
}

func roomIDFromPath(w http.ResponseWriter, r *http.Request) (string, bool) {
	roomID := r.PathValue("id")
	var parsed pgtype.UUID
	if err := parsed.Scan(roomID); err != nil {
		jsonError(w, http.StatusNotFound, "房間不存在")
		return "", false
	}
	return roomID, true
}

// loadHostRoom 驗證房主身分並回房間；非房主回 403、找不到回 404、DB 故障回 500
func loadHostRoom(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) (RoomRow, bool) {
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return RoomRow{}, false
	}
	room, err := LoadRoom(r.Context(), pool, roomID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			jsonError(w, http.StatusNotFound, "房間不存在")
		} else {
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		}
		return room, false
	}
	if room.HostID != UserID(r) {
		jsonError(w, http.StatusForbidden, "只有房主可以執行此操作")
		return room, false
	}
	return room, true
}

// loadMemberRoom：任一成員可用的操作（vote）用這個；房主限定仍走 loadHostRoom
func loadMemberRoom(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) (RoomRow, bool) {
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return RoomRow{}, false
	}
	room, err := LoadRoom(r.Context(), pool, roomID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			jsonError(w, http.StatusNotFound, "房間不存在")
		} else {
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		}
		return room, false
	}
	var isMember bool
	if err := pool.QueryRow(r.Context(),
		`select exists (select 1 from room_members where room_id = $1 and user_id = $2)`,
		room.ID, UserID(r)).Scan(&isMember); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return room, false
	}
	if !isMember {
		jsonError(w, http.StatusForbidden, "你不是這個房間的成員")
		return room, false
	}
	return room, true
}

func handleStartVoting(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	defer tx.Rollback(ctx)
	if err := TransitionRoom(ctx, tx, room.ID, "candidates", "voting"); err != nil {
		if errors.Is(err, ErrConflict) {
			jsonError(w, http.StatusConflict, "房間狀態已變更")
			return
		}
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	jsonOK(w, map[string]string{"status": "voting"})
}

// handleVote：spec §3（Task 0 修訂）— 投票/否決/收回的唯一入口（D15 領域命令）。
//
//	POST /vote {restaurant_id, kind: up|veto, op: cast|retract}
//	     │ 單一交易
//	     ▼
//	TransitionRoom(voting→voting) ─ 條件鎖：驗階段 + room row lock
//	     │                           （序列化同房投票；draw 後回 409 — D2 防線）
//	     ├─ 候選驗證：不在本房名單 → 422
//	     ├─ 互斥：cast 某 kind → 刪自己同店另一 kind
//	     ├─ 限額：cast veto 且他店現存 veto ≥ VetoQuota → 409
//	     ├─ 冪等寫入（insert on conflict do nothing / delete）
//	     └─ inline rescore（其餘資料 tx 內讀；pre-tx room 設定由 guard_room_columns 凍結）→ ReplaceCandidates → commit
func handleVote(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	ctx := r.Context()
	room, ok := loadMemberRoom(w, r, pool)
	if !ok {
		return
	}
	var req struct {
		RestaurantID string `json:"restaurant_id"`
		Kind         string `json:"kind"`
		Op           string `json:"op"`
	}
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		(req.Kind != "up" && req.Kind != "veto") ||
		(req.Op != "cast" && req.Op != "retract") {
		jsonError(w, http.StatusBadRequest, "投票內容格式不正確")
		return
	}
	var restaurantID pgtype.UUID
	if err := restaurantID.Scan(req.RestaurantID); err != nil {
		jsonError(w, http.StatusUnprocessableEntity, "餐廳 ID 格式不正確")
		return
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	defer tx.Rollback(ctx)
	// 刻意的 no-op UPDATE：同時取得 rooms row lock 並檢查階段，勿最佳化移除。
	if err := TransitionRoom(ctx, tx, room.ID, "voting", "voting"); err != nil {
		if errors.Is(err, ErrConflict) {
			jsonError(w, http.StatusConflict, "房間不在投票階段")
			return
		}
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	uid := UserID(r)
	var inRoom bool
	if err := tx.QueryRow(ctx, `select exists (select 1 from room_candidates
		where room_id = $1 and restaurant_id = $2)`, room.ID, req.RestaurantID).Scan(&inRoom); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	if !inRoom {
		jsonError(w, http.StatusUnprocessableEntity, "這家餐廳不在本房的候選名單中")
		return
	}
	if req.Op == "cast" {
		other := "veto"
		if req.Kind == "veto" {
			other = "up"
		}
		if _, err := tx.Exec(ctx, `delete from votes
			where room_id = $1 and user_id = $2 and restaurant_id = $3 and kind = $4`,
			room.ID, uid, req.RestaurantID, other); err != nil {
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
			return
		}
		if req.Kind == "veto" {
			// 排除同店：重複 cast 既有否決不吃額度
			var vetoes int
			if err := tx.QueryRow(ctx, `select count(*) from votes
				where room_id = $1 and user_id = $2 and kind = 'veto'
				  and restaurant_id <> $3`, room.ID, uid, req.RestaurantID).Scan(&vetoes); err != nil {
				jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
				return
			}
			if vetoes >= VetoQuota {
				jsonError(w, http.StatusConflict,
					fmt.Sprintf("否決額度已用完（每人同房同時最多 %d 個）", VetoQuota))
				return
			}
		}
		if _, err := tx.Exec(ctx, `insert into votes (room_id, user_id, restaurant_id, kind)
			values ($1, $2, $3, $4) on conflict do nothing`,
			room.ID, uid, req.RestaurantID, req.Kind); err != nil {
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
			return
		}
	} else { // retract：刪不存在的票也是成功（冪等）
		if _, err := tx.Exec(ctx, `delete from votes
			where room_id = $1 and user_id = $2 and restaurant_id = $3 and kind = $4`,
			room.ID, uid, req.RestaurantID, req.Kind); err != nil {
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
			return
		}
	}
	// inline rescore：其餘資料在 tx 內讀；pre-tx center_* 永遠、exploration 在 lobby 外由 guard_room_columns 凍結（D2）
	members, err := LoadMembers(ctx, tx, room.ID)
	if err != nil || len(members) == 0 {
		jsonError(w, http.StatusInternalServerError, "讀取成員失敗")
		return
	}
	rs, err := LoadRoomRestaurants(ctx, tx, room.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取候選失敗")
		return
	}
	votes, err := LoadVotes(ctx, tx, room.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取投票失敗")
		return
	}
	recency, err := LoadRecency(ctx, tx, memberIDs(members), restaurantIDs(rs))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取同席紀錄失敗")
		return
	}
	exposure, err := LoadExposure(ctx, tx, memberIDs(members), restaurantIDs(rs))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取曝光統計失敗")
		return
	}
	result := Evaluate(EngineInput{Restaurants: rs, Members: members,
		Now: nowInAppTZ(), CenterLat: room.CenterLat, CenterLng: room.CenterLng,
		Votes: votes, Recency: recency, Exposure: exposure, Exploration: room.Exploration})
	if err := ReplaceCandidates(ctx, tx, room.ID, result); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入候選失敗")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	jsonOK(w, resultJSON(result))
}

type keptJSON struct {
	RestaurantID string       `json:"restaurant_id"`
	Name         string       `json:"name"`
	Probability  float64      `json:"probability"`
	Trace        []TraceEntry `json:"trace"`
}

type excludedJSON struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

func resultJSON(result EngineResult) map[string]any {
	kept := []keptJSON{}
	for _, c := range result.Kept {
		kept = append(kept, keptJSON{c.Restaurant.ID, c.Name, c.Probability, c.Trace})
	}
	ex := []excludedJSON{}
	for _, e := range result.Excluded {
		ex = append(ex, excludedJSON{e.Name, e.Reason})
	}
	return map[string]any{"kept": kept, "excluded": ex}
}

func restaurantIDs(rs []Restaurant) []string {
	ids := make([]string, len(rs))
	for i, r := range rs {
		ids[i] = r.ID
	}
	return ids
}

func minimumMemberRadius(members []Member) int {
	radius := members[0].MaxDistanceM
	for _, member := range members[1:] {
		if member.MaxDistanceM < radius {
			radius = member.MaxDistanceM
		}
	}
	return radius
}

func handleSearch(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, places PlacesProvider) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	if room.Status != "lobby" {
		jsonError(w, http.StatusConflict, "房間狀態已變更")
		return
	}
	// Places 呼叫付費，同房並發搜尋只放行一個。
	if _, loaded := searchInFlight.LoadOrStore(room.ID, struct{}{}); loaded {
		jsonError(w, http.StatusConflict, "房間狀態已變更")
		return
	}
	defer searchInFlight.Delete(room.ID)
	members, err := LoadMembers(ctx, pool, room.ID)
	if err != nil || len(members) == 0 {
		jsonError(w, http.StatusInternalServerError, "讀取成員失敗")
		return
	}
	fetchedRadius := minimumMemberRadius(members)
	// Provider fetch envelope 採 call-time 成員最小距離；tx 內重讀若縮小，會在 Evaluate 前重濾。
	// 若期間放寬，既有 fetch envelope 只會 under-fetch，不會錯誤納入更遠餐廳。
	found, err := places.SearchNearby(ctx, room.CenterLat, room.CenterLng, fetchedRadius)
	degraded := false
	var closedIDs []string
	if err != nil {
		log.Printf("places provider failed, falling back to cache: %v", err)
		// provider 內已重試一次（spec §8）；此處 fallback 30 天內快取
		// Google fallback 不可混入先前 mock provider 寫入的罐頭資料。
		_, isGoogle := places.(*googleProvider)
		found, err = LoadCachedRestaurants(ctx, pool, room.CenterLat, room.CenterLng, fetchedRadius, isGoogle)
		if err != nil || len(found) == 0 {
			jsonError(w, http.StatusBadGateway, "餐廳搜尋失敗，且沒有可用的快取資料，請稍後再試")
			return
		}
		degraded = true
	} else {
		open := found[:0]
		for _, restaurant := range found {
			if restaurant.Closed {
				closedIDs = append(closedIDs, restaurant.PlaceID)
				continue
			}
			open = append(open, restaurant)
		}
		found = open
		// 去重並固定 upsert 順序，避免重複候選與跨房 restaurants row-lock deadlock。
		sort.Slice(found, func(i, j int) bool { return found[i].PlaceID < found[j].PlaceID })
		deduped := found[:0]
		for _, restaurant := range found {
			if len(deduped) == 0 || restaurant.PlaceID != deduped[len(deduped)-1].PlaceID {
				deduped = append(deduped, restaurant)
			}
		}
		found = deduped
	}
	// 快取寫入獨立交易先 commit：即使零候選 rollback，真 API 的呼叫成果仍留作快取。
	// fallback 的 found 已含 DB uuid 且本來就出自快取，因此跳過重寫。
	if !degraded && (len(found) > 0 || len(closedIDs) > 0) {
		txCache, err := pool.Begin(ctx)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
			return
		}
		defer txCache.Rollback(ctx)
		if err := StaleOutRestaurants(ctx, txCache, closedIDs); err != nil {
			jsonError(w, http.StatusInternalServerError, "寫入餐廳快取失敗")
			return
		}
		if err := UpsertRestaurants(ctx, txCache, found); err != nil {
			jsonError(w, http.StatusInternalServerError, "寫入餐廳快取失敗")
			return
		}
		if err := txCache.Commit(ctx); err != nil {
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
			return
		}
	}
	// 「附近根本沒資料」和「有資料但全被條件排除」是兩種不同的死路，
	// 混成同一個 422 會叫使用者去放寬條件卻永遠沒用 — 分流才誠實
	if len(found) == 0 {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		jsonOK(w, map[string]any{
			"error":    "no_restaurants_in_range",
			"message":  "此位置附近沒有餐廳資料，請調整位置或縮小距離再試",
			"degraded": degraded,
		})
		return
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	defer tx.Rollback(ctx)
	if err := TransitionRoom(ctx, tx, room.ID, "lobby", "candidates"); err != nil {
		if errors.Is(err, ErrConflict) {
			jsonError(w, http.StatusConflict, "房間狀態已變更")
			return
		}
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	// exploration 在 lobby 仍可變，鎖定後重讀；center_* 由 guard 永凍毋需重讀
	if err := tx.QueryRow(ctx, `select exploration from rooms where id = $1`, room.ID).Scan(&room.Exploration); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	members, err = LoadMembersForUpdate(ctx, tx, room.ID)
	if err != nil || len(members) == 0 {
		jsonError(w, http.StatusInternalServerError, "讀取成員失敗")
		return
	}
	reloadedRadius := minimumMemberRadius(members)
	// tx 內重讀的「全員最小距離」有三種情況：縮小則重濾、相等則直接繼續；
	// 放大代表先前的 fetch envelope under-fetch，回 409 並由 deferred rollback 留在 lobby，讓 host 重搜。
	if reloadedRadius > fetchedRadius {
		jsonError(w, http.StatusConflict, "成員條件已於搜尋期間變更，請再按一次開始搜尋")
		return
	}
	if reloadedRadius < fetchedRadius {
		withinReloadedRadius := found[:0]
		for _, restaurant := range found {
			if Haversine(room.CenterLat, room.CenterLng, restaurant.Lat, restaurant.Lng) <= float64(reloadedRadius) {
				withinReloadedRadius = append(withinReloadedRadius, restaurant)
			}
		}
		found = withinReloadedRadius
	}
	recency, err := LoadRecency(ctx, tx, memberIDs(members), restaurantIDs(found))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取同席紀錄失敗")
		return
	}
	exposure, err := LoadExposure(ctx, tx, memberIDs(members), restaurantIDs(found))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取曝光統計失敗")
		return
	}
	result := Evaluate(EngineInput{Restaurants: found, Members: members,
		Now: nowInAppTZ(), CenterLat: room.CenterLat, CenterLng: room.CenterLng,
		Recency: recency, Exposure: exposure, Exploration: room.Exploration})

	if len(result.Kept) == 0 {
		byKind := map[string]int{}
		ex := []excludedJSON{}
		for _, e := range result.Excluded {
			for _, k := range e.Kinds {
				byKind[k]++
			}
			ex = append(ex, excludedJSON{e.Name, e.Reason})
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		jsonOK(w, map[string]any{
			"error": "no_candidates", "excluded": ex, "excluded_by": byKind, "degraded": degraded,
		})
		return
	}
	if err := ReplaceCandidates(ctx, tx, room.ID, result); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入候選失敗")
		return
	}
	keptIDs := make([]string, len(result.Kept))
	for i, c := range result.Kept {
		keptIDs[i] = c.Restaurant.ID
	}
	// 順序不變式：LoadExposure → Evaluate → RecordExposure，避免本次 +1 汙染新店判定。
	if err := RecordExposure(ctx, tx, memberIDs(members), keptIDs); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入曝光統計失敗")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	resp := resultJSON(result)
	resp["degraded"] = degraded
	jsonOK(w, resp)
}

func handleDraw(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	if room.Status != "voting" {
		jsonError(w, http.StatusConflict, "房間狀態不允許抽選")
		return
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	defer tx.Rollback(ctx)
	if err := TransitionRoom(ctx, tx, room.ID, "voting", "decided"); err != nil {
		if errors.Is(err, ErrConflict) {
			jsonError(w, http.StatusConflict, "房間狀態已變更")
			return
		}
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	members, err := LoadMembers(ctx, tx, room.ID)
	if err != nil || len(members) == 0 {
		jsonError(w, http.StatusInternalServerError, "讀取成員失敗")
		return
	}
	rs, err := LoadRoomRestaurants(ctx, tx, room.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取候選失敗")
		return
	}
	votes, err := LoadVotes(ctx, tx, room.ID)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取投票失敗")
		return
	}
	recency, err := LoadRecency(ctx, tx, memberIDs(members), restaurantIDs(rs))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取同席紀錄失敗")
		return
	}
	exposure, err := LoadExposure(ctx, tx, memberIDs(members), restaurantIDs(rs))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取曝光統計失敗")
		return
	}
	// spec §5.5：抽選前權威重算；pre-tx center_* 永遠、exploration 在 lobby 外由 guard_room_columns 凍結
	result := Evaluate(EngineInput{Restaurants: rs, Members: members,
		Now: nowInAppTZ(), CenterLat: room.CenterLat, CenterLng: room.CenterLng,
		Votes: votes, Recency: recency, Exposure: exposure, Exploration: room.Exploration})
	if len(result.Kept) == 0 {
		for _, e := range result.Excluded {
			if hasKind(e.Kinds, "veto") {
				jsonError(w, http.StatusConflict, "候選已全數被否決，請成員收回否決後再抽選")
				return
			}
		}
		jsonError(w, http.StatusConflict, "候選已全數失效（可能都打烊了），請建立新房間重新搜尋")
		return
	}
	winner, seed := Draw(result.Kept)
	probs := map[string]float64{}
	for _, c := range result.Kept {
		probs[c.Restaurant.ID] = c.Probability
	}
	if err := ReplaceCandidates(ctx, tx, room.ID, result); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入候選失敗")
		return
	}
	if _, err := tx.Exec(ctx,
		`insert into draws (room_id, seed, winner_restaurant_id, probabilities)
		 values ($1, $2, $3, $4)`, room.ID, seed, winner, probs); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "23505" { // unique(room_id)：並發抽選輸家
			jsonError(w, http.StatusConflict, "已抽選過")
			return
		}
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	if err := RecordDecision(ctx, tx, room.ID, memberIDs(members), winner); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入同席紀錄失敗")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	jsonOK(w, map[string]string{"winner_restaurant_id": winner, "seed": seed})
}

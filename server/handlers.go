package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net/http"
	"net/url"
	"slices"
	"sort"
	"sync"
	"time"

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

func buildRoutes(v *Verifier, pool *pgxpool.Pool, places PlacesProvider, weather WeatherProvider, rl *limiterStore) http.Handler {
	// single-flight 狀態綁在路由實例上，避免跨測試/跨實例透過 process 全域耦合
	var searchInFlight sync.Map
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, map[string]bool{"ok": true})
	})
	api := http.NewServeMux()
	api.HandleFunc("POST /api/rooms/{id}/search", func(w http.ResponseWriter, r *http.Request) {
		handleSearch(w, r, pool, places, weather, &searchInFlight)
	})
	api.HandleFunc("POST /api/rooms/{id}/start-voting", func(w http.ResponseWriter, r *http.Request) {
		handleStartVoting(w, r, pool)
	})
	api.HandleFunc("POST /api/rooms/{id}/vote", func(w http.ResponseWriter, r *http.Request) {
		handleVote(w, r, pool, weather)
	})
	api.HandleFunc("POST /api/rooms/{id}/draw", func(w http.ResponseWriter, r *http.Request) {
		handleDraw(w, r, pool, weather)
	})
	api.HandleFunc("POST /api/leave", func(w http.ResponseWriter, r *http.Request) {
		handleLeave(w, r, pool, weather)
	})
	mux.Handle("/api/", v.Middleware(rateLimit(rl, api)))
	return cors(mux)
}

// loadWeather：天氣是加分資料，失敗不阻斷（比 Places 降級更輕：連橫幅都不用）
func loadWeather(ctx context.Context, wp WeatherProvider, lat, lng float64, at time.Time) *Weather {
	if wp == nil {
		return nil
	}
	w, err := wp.Current(ctx, lat, lng, at)
	if err != nil {
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		log.Printf("weather provider failed, scoring without weather: %v", err)
		return nil
	}
	return &w
}

// loadWeatherCached：vote 熱路徑版——只讀快取、永不發網路（eng review D6）。
// miss 就當無資料（中性）；快取由前一次 search/draw 的 blocking fetch 餵飽。
func loadWeatherCached(wp WeatherProvider, lat, lng float64, at time.Time) *Weather {
	if wp == nil {
		return nil
	}
	if w, ok := wp.CurrentCached(lat, lng, at); ok {
		return &w
	}
	return nil
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
//	     ├─ castVote：候選驗證+互斥+限額+冪等（vote.go）
//	     └─ inline rescore（其餘資料 tx 內讀；pre-tx room 設定由 guard_room_columns 凍結）→ ReplaceCandidates → commit
func handleVote(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, weather WeatherProvider) {
	ctx := r.Context()
	room, ok := loadMemberRoom(w, r, pool)
	if !ok {
		return
	}
	var req VoteCommand
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
	wx := loadWeatherCached(weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
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
	vetoesRemaining, err := castVote(ctx, tx, room.ID, uid, req)
	if err != nil {
		switch {
		case errors.Is(err, ErrNotMember):
			jsonError(w, http.StatusForbidden, "你不是這個房間的成員")
		case errors.Is(err, ErrNotCandidate):
			jsonError(w, http.StatusUnprocessableEntity, "這家餐廳不在本房的候選名單中")
		case errors.Is(err, ErrVetoQuotaExceeded):
			jsonError(w, http.StatusConflict,
				fmt.Sprintf("否決額度已用完（每人同房同時最多 %d 個）", VetoQuota))
		default:
			log.Printf("vote command failed: %v", err)
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		}
		return
	}
	// inline rescore（ADR-0003）：載入順序、baseline 與落盤細節見 rescoreRoom
	result, _, err := rescoreRoom(ctx, tx, room, wx)
	if err != nil {
		log.Printf("vote rescore failed: %v", err)
		jsonError(w, http.StatusInternalServerError, "重算失敗，請稍後再試")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	resp := resultJSON(result)
	resp["vetoes_remaining"] = vetoesRemaining
	jsonOK(w, resp)
}

type keptJSON struct {
	RestaurantID string       `json:"restaurant_id"`
	Name         string       `json:"name"`
	Probability  float64      `json:"probability"`
	Trace        []TraceEntry `json:"trace"`
}

type excludedJSON struct {
	Name   string   `json:"name"`
	Reason string   `json:"reason"`
	Kinds  []string `json:"kinds"`
}

// nonNilKinds 保證編碼端拿到 non-nil slice：DB 欄位 not null、JSON 出 [] 而非 null
func nonNilKinds(kinds []string) []string {
	if kinds == nil {
		return []string{}
	}
	return kinds
}

func resultJSON(result EngineResult) map[string]any {
	kept := []keptJSON{}
	for _, c := range result.Kept {
		kept = append(kept, keptJSON{c.Restaurant.ID, c.Name, c.Probability, c.Trace})
	}
	ex := []excludedJSON{}
	for _, e := range result.Excluded {
		ex = append(ex, excludedJSON{e.Name, e.Reason, nonNilKinds(e.Kinds)})
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

// averageMemberRadius：搜尋半徑取全員 max_distance_m 的平均（整數公尺，sum/len 截斷小數）。
// 取平均而不是取最小值：最小值等於讓設得最緊的那一位獨自決定全房的搜尋圈，其他人的設定
// 完全不算數——一個人填 300 公尺，全房就只看得到 300 公尺內的店。平均讓每個人的上限都
// 對結果有貢獻，代價是它會超出某些成員的個人上限（距離仍在計分端以軟性權重反映，
// 見 engine.go distFactor）。
// 呼叫端保證 members 非空（handleSearch 的 len==0 回 500、freezeAndLoadMembers 回 error）。
func averageMemberRadius(members []Member) int {
	sum := 0
	for _, member := range members {
		sum += member.MaxDistanceM
	}
	return sum / len(members)
}

// 搜尋期間成員條件變動的統一回覆。抽成常數而非寫字面量：前端可能在比對字串，
// 且 Go 測試以同一段文字釘住這條路徑。
const searchConditionsChangedMessage = "成員條件已於搜尋期間變更，請再按一次開始搜尋"

// handleSearch 有兩條 early return 走在凍結之前——provider 失敗且快取為空的 502、零餐廳的
// 422——它們手上的空結果可能只是因為搜尋繞的是舊的、更小的半徑。此時 422 叫使用者「縮小
// 距離」方向剛好相反：正解是有人剛加入把搜尋圈推大了，再搜一次就會有結果。
// 半徑取最小值的年代不需要這條檢查：新成員加入只可能把最小值壓小（他的上限更大則最小值
// 不變），舊 envelope 永遠是新條件的超集，搜到零筆就是真的零筆。改取平均之後，任何一位
// max_distance_m 高於現有平均的成員加入都會把半徑推大（300 + 3000 兩人 → 1650），舊
// envelope 不再是超集。所以這不是多餘的重複查詢，是那兩條 early return 唯一的半徑檢查
// （凍結交易內的那次見 freeze.go，走不到那裡）。
// 只有放大回 true：縮小或相等時舊 envelope 仍是超集——找到的東西仍有效（freeze 會重濾），
// 且用更大的半徑都搜到零筆，用更小的一樣是零。
func memberRadiusGrew(ctx context.Context, pool *pgxpool.Pool, roomID string, fetchedRadius int) (bool, error) {
	members, err := LoadMembers(ctx, pool, roomID)
	if err != nil {
		return false, err
	}
	// 期間全員退房：averageMemberRadius 對空 slice 會除以零，且「沒有成員」不是半徑放大。
	if len(members) == 0 {
		return false, nil
	}
	return averageMemberRadius(members) > fetchedRadius, nil
}

func memberCuisinesDrifted(ctx context.Context, pool *pgxpool.Pool, roomID string, fetched []string) (bool, error) {
	var filterEnabled bool
	if err := pool.QueryRow(ctx, `select cuisine_filter from rooms where id = $1`, roomID).Scan(&filterEnabled); err != nil {
		return false, err
	}
	if !filterEnabled {
		return false, nil
	}
	members, err := LoadMembers(ctx, pool, roomID)
	if err != nil {
		return false, err
	}
	// 期間全員退房：聯集變空 ≠ fetched 時刻意回 409（人走了條件確實變了，freeze 同樣會擋）；與 memberRadiusGrew 回 false 的不對稱是有意為之。
	return !slices.Equal(cuisineUnion(members), fetched), nil
}

func handleSearch(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, places PlacesProvider, weather WeatherProvider, inFlight *sync.Map) {
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
	if _, loaded := inFlight.LoadOrStore(room.ID, struct{}{}); loaded {
		jsonError(w, http.StatusConflict, "房間狀態已變更")
		return
	}
	defer inFlight.Delete(room.ID)
	// wx 用 pre-tx 的 roomEvalTime(room) 取（凍結重讀前）；host 在按鈕與凍結之間改時間的競態
	// 只影響天氣取樣的小時，屬可接受誤差（exploration 的 pre-tx 讀取同款先例）。
	wx := loadWeather(ctx, weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
	members, err := LoadMembers(ctx, pool, room.ID)
	if err != nil || len(members) == 0 {
		jsonError(w, http.StatusInternalServerError, "讀取成員失敗")
		return
	}
	fetchedRadius := averageMemberRadius(members)
	fetchedCuisines := cuisineUnion(members)
	// Provider fetch envelope 採 call-time 成員平均距離；tx 內重讀若縮小，會在 Evaluate 前重濾。
	// 若期間放寬，既有 fetch envelope 只會 under-fetch，不會錯誤納入更遠餐廳（freeze.go 回 409）。
	searchResult, err := places.SearchNearby(ctx, room.CenterLat, room.CenterLng, fetchedRadius, fetchedCuisines)
	found := searchResult.Restaurants
	degraded := false
	var closedIDs []string
	// 只涵蓋本次 provider 看見並拒絕的 ID；被 request blocklist 擋住的歷史快取需另行清理或等 TTL。
	rejectedIDs := searchResult.RejectedPlaceIDs
	if err != nil {
		log.Printf("places provider failed, falling back to cache: %v", err)
		// provider 內已重試一次（spec §8）；此處 fallback 30 天內快取
		// Google fallback 不可混入先前 mock provider 寫入的罐頭資料。
		isGoogle := places.Source() == "google"
		found, err = LoadCachedRestaurants(ctx, pool, room.CenterLat, room.CenterLng, fetchedRadius, isGoogle)
		if err != nil || len(found) == 0 {
			// 快取撈的也是舊的、更小的半徑，半徑若已被推大，「沒有可用的快取」是錯的診斷。
			if grew, radiusErr := memberRadiusGrew(ctx, pool, room.ID, fetchedRadius); radiusErr != nil {
				// 檢查本身失敗不遮蔽原本的錯誤，照常回 502。
				log.Printf("member radius growth check failed: %v", radiusErr)
			} else if grew {
				jsonError(w, http.StatusConflict, searchConditionsChangedMessage)
				return
			}
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
	closedIDs = append(closedIDs, searchResult.DiscardedClosedPlaceIDs...)
	// 快取寫入獨立交易先 commit：即使零候選 rollback，真 API 的呼叫成果仍留作快取。
	// fallback 的 found 已含 DB uuid 且本來就出自快取，因此跳過重寫。
	if !degraded && (len(found) > 0 || len(closedIDs) > 0 || len(rejectedIDs) > 0) {
		txCache, err := pool.Begin(ctx)
		if err != nil {
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
			return
		}
		defer txCache.Rollback(ctx)
		staleIDs := append(closedIDs, rejectedIDs...)
		if err := StaleOutRestaurants(ctx, txCache, staleIDs); err != nil {
			jsonError(w, http.StatusInternalServerError, "寫入餐廳快取失敗")
			return
		}
		if err := UpsertRestaurants(ctx, txCache, found, places.Source()); err != nil {
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
		// 零筆也可能只是因為搜尋繞的是舊的、更小的半徑（成員在 SearchNearby 期間加入把平均推大）。
		// 菜系聯集在 fan-out 期間漂移也有同型窗口：過濾開啟時，舊聯集的空結果不能當成權威結果。
		// 這條檢查必須自己做一次，不能與 502 那條合併成 SearchNearby 之後的單一檢查：
		// 那樣從檢查點到這裡之間仍有殘留窗口，422 又會回到叫使用者「縮小距離」的反方向建議。
		if grew, radiusErr := memberRadiusGrew(ctx, pool, room.ID, fetchedRadius); radiusErr != nil {
			// 檢查本身失敗不遮蔽原本的結果，照常回 422。
			log.Printf("member radius growth check failed: %v", radiusErr)
		} else if grew {
			jsonError(w, http.StatusConflict, searchConditionsChangedMessage)
			return
		}
		if drifted, cuisineErr := memberCuisinesDrifted(ctx, pool, room.ID, fetchedCuisines); cuisineErr != nil {
			// 檢查本身失敗不遮蔽原本的結果，照常回 422。
			log.Printf("member cuisine drift check failed: %v", cuisineErr)
		} else if drifted {
			jsonError(w, http.StatusConflict, searchConditionsChangedMessage)
			return
		}
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
	members, found, err = freezeAndLoadMembers(ctx, tx, &room, fetchedRadius, fetchedCuisines, found)
	if err != nil {
		switch {
		case errors.Is(err, ErrConflict):
			jsonError(w, http.StatusConflict, "房間狀態已變更")
		case errors.Is(err, ErrMembersChanged):
			jsonError(w, http.StatusConflict, searchConditionsChangedMessage)
		default:
			log.Printf("search freeze failed: %v", err)
			jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		}
		return
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
	satisfaction, err := LoadSatisfaction(ctx, tx, memberIDs(members))
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "讀取滿足度失敗")
		return
	}
	result := Evaluate(EngineInput{Restaurants: found, Members: members,
		Now: roomEvalTime(room), CenterLat: room.CenterLat, CenterLng: room.CenterLng,
		Weather: wx, Recency: recency, Exposure: exposure, Satisfaction: satisfaction,
		Exploration: room.Exploration, CuisineFilter: room.CuisineFilter})

	if len(result.Kept) == 0 {
		byKind := map[string]int{}
		ex := []excludedJSON{}
		for _, e := range result.Excluded {
			for _, k := range e.Kinds {
				byKind[k]++
			}
			ex = append(ex, excludedJSON{e.Name, e.Reason, nonNilKinds(e.Kinds)})
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		jsonOK(w, map[string]any{
			"error": "no_candidates", "excluded": ex, "excluded_by": byKind, "degraded": degraded,
		})
		return
	}
	keptIDs := make([]string, len(result.Kept))
	exposureCounted := make(map[string]bool, len(result.Kept))
	for i, c := range result.Kept {
		keptIDs[i] = c.Restaurant.ID
		exposureCounted[c.Restaurant.ID] = true
	}
	if err := ReplaceCandidates(ctx, tx, room.ID, result, exposureCounted); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入候選失敗")
		return
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

func handleDraw(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, weather WeatherProvider) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	if room.Status != "voting" {
		jsonError(w, http.StatusConflict, "房間狀態不允許抽選")
		return
	}
	wx := loadWeather(ctx, weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
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
	// spec §5.5：抽選前權威重算；細節見 rescoreRoom
	result, members, err := rescoreRoom(ctx, tx, room, wx)
	if err != nil {
		log.Printf("draw rescore failed: %v", err)
		jsonError(w, http.StatusInternalServerError, "重算失敗，請稍後再試")
		return
	}
	// 候選已由 rescoreRoom 落盤；此處所有早退都在 commit 前，deferred rollback 會撤回。
	// （持久化失敗時回 500 而非死路 409——寫入真的失敗了，500 才誠實。）
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
	var winnerRest Restaurant
	for _, c := range result.Kept {
		if c.Restaurant.ID == winner {
			winnerRest = c.Restaurant
			break
		}
	}
	if err := RecordDecision(ctx, tx, room.ID, members, winnerRest); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入同席紀錄失敗")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
		return
	}
	jsonOK(w, map[string]string{"winner_restaurant_id": winner, "seed": seed})
}

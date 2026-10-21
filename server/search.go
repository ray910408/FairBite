package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"slices"
	"sort"
	"sync"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

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

const searchNotReadyMessage = "仍有成員尚未準備，請等待所有成員完成條件設定"

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
	members, err := LoadMembers(ctx, pool, roomID)
	if err != nil {
		return false, err
	}
	// 期間全員退房：聯集變空 ≠ fetched 時刻意回 409（人走了條件確實變了，freeze 同樣會擋）；
	// 與 memberRadiusGrew 回 false 的不對稱是有意為之。
	reloaded := cuisineUnion(members)
	if slices.Equal(reloaded, fetched) {
		return false, nil
	}
	// 閘門拆兩層的理由見 freeze.go——菜系吃 cuisine_filter，嚴格禁忌不吃、且只看新增方向。
	if !filterEnabled {
		return strictDietaryUnderFetched(reloaded, fetched), nil
	}
	return true, nil
}

func handleSearch(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, places PlacesProvider, weather WeatherProvider, inFlight *sync.Map) {
	// Must finish before the durable 60-second concurrency lease expires.
	ctx, cancel := context.WithTimeout(r.Context(), 45*time.Second)
	defer cancel()
	r = r.WithContext(ctx)
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
	members, err := LoadMembers(ctx, pool, room.ID)
	if err != nil || len(members) == 0 {
		if err == nil {
			err = errors.New("room has no members")
		}
		serverError(w, err, "讀取成員失敗")
		return
	}
	// 付費 provider 前先擋 old/direct client；freeze transaction 會再鎖定重查一次競態。
	if !allGuestsReady(members, room.HostID) {
		jsonError(w, http.StatusConflict, searchNotReadyMessage)
		return
	}
	fetchedRadius := averageMemberRadius(members)
	fetchedCuisines := cuisineUnion(members)
	paidCalls := 0
	if places.Source() == "google" {
		paidCalls = googleSearchRequestBudget(fetchedCuisines)
	}
	lease, err := reserveSearchQuota(ctx, pool, UserID(r), room.ID, paidCalls)
	if err != nil {
		if errors.Is(err, ErrSearchQuota) {
			w.Header().Set("Retry-After", "60")
			jsonError(w, http.StatusTooManyRequests, "搜尋額度已用完或系統忙碌，請稍後再試")
		} else {
			log.Printf("search quota check failed: %v", err)
			jsonError(w, http.StatusServiceUnavailable, "搜尋額度檢查失敗，請稍後再試")
		}
		return
	}
	defer func() {
		cleanupCtx, cleanupCancel := context.WithTimeout(context.Background(), 2*time.Second)
		defer cleanupCancel()
		if _, err := pool.Exec(cleanupCtx, `select public.release_search_quota($1)`, lease); err != nil {
			log.Printf("search quota lease release failed: %v", err)
		}
	}()
	// wx 用 pre-tx 的 roomEvalTime(room) 取（凍結重讀前）；host 在按鈕與凍結之間改時間的競態
	// 只影響天氣取樣的小時，屬可接受誤差（exploration 的 pre-tx 讀取同款先例）。
	// 天氣與 Places 並行：wx 到凍結才用，不必讓 Places 排在天氣後面。參數在發車前取值，
	// 仍是 pre-tx 的 room。容量 1：中途提早 return 時沒人收，goroutine 照樣寫得進去就結束；
	// return 觸發 defer cancel()，在途的天氣請求跟著取消，不會洩漏。
	wxCh := make(chan *Weather, 1)
	go func(lat, lng float64, at time.Time) {
		wxCh <- loadWeather(ctx, weather, lat, lng, at)
	}(room.CenterLat, room.CenterLng, roomEvalTime(room))
	fetched, ok := fetchSearchRestaurants(w, ctx, pool, places, room, fetchedRadius, fetchedCuisines)
	if !ok {
		return
	}
	fetched.found, ok = cacheSearchRestaurants(w, ctx, pool, places, fetched)
	if !ok {
		return
	}
	// 「附近根本沒資料」和「有資料但全被條件排除」是兩種不同的死路，
	// 混成同一個 422 會叫使用者去放寬條件卻永遠沒用 — 分流才誠實
	if len(fetched.found) == 0 {
		respondNoRestaurants(w, ctx, pool, room, fetchedRadius, fetchedCuisines, fetched)
		return
	}
	// 開凍結交易前先收 wx：別讓交易開著等天氣。
	result, ok := freezeSearchCandidates(w, r, pool, room, fetchedRadius, fetchedCuisines, fetched, <-wxCh)
	if !ok {
		return
	}
	resp := resultJSON(result)
	resp["degraded"] = fetched.degraded
	jsonOK(w, resp)
}

// searchFetch 是 provider（或 30 天快取 fallback）取回並濾過的搜尋結果，供 handleSearch 後段共用。
type searchFetch struct {
	found              []Restaurant
	degraded           bool
	closedIDs          []string
	rejectedIDs        []string
	unfulfilledDietary []string
}

// fetchSearchRestaurants 呼叫 provider；失敗時退回 30 天快取，成功時濾掉歇業並去重。ok=false 表示已回應。
func fetchSearchRestaurants(w http.ResponseWriter, ctx context.Context, pool *pgxpool.Pool, places PlacesProvider, room RoomRow, fetchedRadius int, fetchedCuisines []string) (searchFetch, bool) {
	// Provider fetch envelope 採 call-time 成員平均距離；tx 內重讀若縮小，會在 Evaluate 前重濾。
	// 若期間放寬，既有 fetch envelope 只會 under-fetch，不會錯誤納入更遠餐廳（freeze.go 回 409）。
	searchResult, err := places.SearchNearby(ctx, room.CenterLat, room.CenterLng, fetchedRadius, fetchedCuisines)
	found := searchResult.Restaurants
	degraded := false
	var closedIDs []string
	// 只涵蓋本次 provider 看見並拒絕的 ID；被 request blocklist 擋住的歷史快取需另行清理或等 TTL。
	rejectedIDs := searchResult.RejectedPlaceIDs
	// 嚴格禁忌（DietaryRequires）的定向檢索失敗＝該成員零候選，與「這區真的沒有」是兩種
	// 死路：前者要叫人重試，後者才要叫人放寬。菜系檢索失敗只少了補召回（spec §7 容忍不
	// 降級），刻意不進這個欄位——否則前端會為一個可容忍的失敗改口。兩條 422 都要帶，
	// 檢索掛掉時「附近沒餐廳」同樣可能只是結果不完整。降級路徑的 searchResult 是零值。
	unfulfilledDietary := nonNilKinds(strictDietaryTerms(searchResult.UnfulfilledTerms))
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
				return searchFetch{}, false
			}
			if rejectChangedSearchSnapshot(w, ctx, pool, room) {
				return searchFetch{}, false
			}
			jsonError(w, http.StatusBadGateway, "餐廳搜尋失敗，且沒有可用的快取資料，請稍後再試")
			return searchFetch{}, false
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
	return searchFetch{
		found:              found,
		degraded:           degraded,
		closedIDs:          closedIDs,
		rejectedIDs:        rejectedIDs,
		unfulfilledDietary: unfulfilledDietary,
	}, true
}

// cacheSearchRestaurants 以獨立交易寫入餐廳快取並 commit，回傳帶 DB uuid 的 found。回 false 表示已回應。
func cacheSearchRestaurants(w http.ResponseWriter, ctx context.Context, pool *pgxpool.Pool, places PlacesProvider, fetched searchFetch) ([]Restaurant, bool) {
	found := fetched.found
	// 快取寫入獨立交易先 commit：即使零候選 rollback，真 API 的呼叫成果仍留作快取。
	// fallback 的 found 已含 DB uuid 且本來就出自快取，因此跳過重寫。
	if !fetched.degraded && (len(fetched.found) > 0 || len(fetched.closedIDs) > 0 || len(fetched.rejectedIDs) > 0) {
		txCache, err := pool.Begin(ctx)
		if err != nil {
			serverError(w, err, "資料庫錯誤，請稍後再試")
			return nil, false
		}
		defer txCache.Rollback(ctx)
		staleIDs := append(fetched.closedIDs, fetched.rejectedIDs...)
		if err := StaleOutRestaurants(ctx, txCache, staleIDs); err != nil {
			serverError(w, err, "寫入餐廳快取失敗")
			return nil, false
		}
		if found, err = UpsertRestaurants(ctx, txCache, fetched.found, places.Source()); err != nil {
			serverError(w, err, "寫入餐廳快取失敗")
			return nil, false
		}
		if err := txCache.Commit(ctx); err != nil {
			serverError(w, err, "資料庫錯誤，請稍後再試")
			return nil, false
		}
	}
	return found, true
}

// respondNoRestaurants 回應零餐廳：先排除搜尋期間條件或位置已變更的 409，才回 no_restaurants_in_range 422。
func respondNoRestaurants(w http.ResponseWriter, ctx context.Context, pool *pgxpool.Pool, room RoomRow, fetchedRadius int, fetchedCuisines []string, fetched searchFetch) {
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
	if rejectChangedSearchSnapshot(w, ctx, pool, room) {
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(http.StatusUnprocessableEntity)
	jsonOK(w, map[string]any{
		"error":                     "no_restaurants_in_range",
		"message":                   "此位置附近沒有餐廳資料，請調整位置或縮小距離再試",
		"degraded":                  fetched.degraded,
		"unfulfilled_dietary_terms": fetched.unfulfilledDietary,
	})
}

// freezeSearchCandidates 在凍結交易內重驗房主、重讀成員、評分並寫入候選與曝光後 commit。
// ok=false 表示已回應（含 no_candidates 422）。
func freezeSearchCandidates(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, room RoomRow, fetchedRadius int, fetchedCuisines []string, fetched searchFetch, wx *Weather) (EngineResult, bool) {
	ctx := r.Context()
	tx, err := pool.Begin(ctx)
	if err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return EngineResult{}, false
	}
	defer tx.Rollback(ctx)
	// Provider call 期間可能發生房主繼任；先在 room lock 下重驗權限，避免向前房主洩漏 readiness。
	// 唯一成員同期退房、房間被刪則是 ErrRoomNotFound → 404。
	if err := assertHostInTx(ctx, tx, room.ID, UserID(r)); err != nil {
		roomError(w, err, "房間狀態已變更")
		return EngineResult{}, false
	}
	members, found, err := freezeAndLoadMembers(ctx, tx, &room, fetchedRadius, fetchedCuisines, fetched.found)
	if err != nil {
		switch {
		case errors.Is(err, ErrConflict):
			jsonError(w, http.StatusConflict, "房間狀態已變更")
		case errors.Is(err, ErrMembersChanged):
			jsonError(w, http.StatusConflict, searchConditionsChangedMessage)
		case errors.Is(err, ErrSearchChanged):
			jsonError(w, http.StatusConflict, "搜尋位置已更新，請重新搜尋")
		case errors.Is(err, ErrNotReady):
			jsonError(w, http.StatusConflict, searchNotReadyMessage)
		default:
			serverError(w, err, "資料庫錯誤，請稍後再試")
		}
		return EngineResult{}, false
	}
	recency, err := LoadRecency(ctx, tx, memberIDs(members), restaurantIDs(found))
	if err != nil {
		serverError(w, err, "讀取同席紀錄失敗")
		return EngineResult{}, false
	}
	exposure, err := LoadExposure(ctx, tx, memberIDs(members), restaurantIDs(found))
	if err != nil {
		serverError(w, err, "讀取曝光統計失敗")
		return EngineResult{}, false
	}
	satisfaction, err := LoadSatisfaction(ctx, tx, memberIDs(members))
	if err != nil {
		serverError(w, err, "讀取滿足度失敗")
		return EngineResult{}, false
	}
	evalAt, departNow := roomEvalMoment(room)
	result := Evaluate(EngineInput{Restaurants: found, Members: members,
		Now: evalAt, DepartNow: departNow, CenterLat: room.CenterLat, CenterLng: room.CenterLng,
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
			"error": "no_candidates", "excluded": ex, "excluded_by": byKind, "degraded": fetched.degraded,
			"unfulfilled_dietary_terms": fetched.unfulfilledDietary,
		})
		return EngineResult{}, false
	}
	keptIDs := make([]string, len(result.Kept))
	exposureCounted := make(map[string]bool, len(result.Kept))
	for i, c := range result.Kept {
		keptIDs[i] = c.Restaurant.ID
		exposureCounted[c.Restaurant.ID] = true
	}
	if err := ReplaceCandidates(ctx, tx, room.ID, result, exposureCounted); err != nil {
		serverError(w, err, "寫入候選失敗")
		return EngineResult{}, false
	}
	// 順序不變式：LoadExposure → Evaluate → RecordExposure，避免本次 +1 汙染新店判定。
	if err := RecordExposure(ctx, tx, memberIDs(members), keptIDs); err != nil {
		serverError(w, err, "寫入曝光統計失敗")
		return EngineResult{}, false
	}
	if err := tx.Commit(ctx); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return EngineResult{}, false
	}
	return result, true
}

func rejectChangedSearchSnapshot(w http.ResponseWriter, ctx context.Context, q querier, room RoomRow) bool {
	err := checkSearchSnapshot(ctx, q, room.ID, room.SearchVersion, room.CenterLat, room.CenterLng)
	if err == nil {
		return false
	}
	switch {
	case errors.Is(err, ErrSearchChanged):
		jsonError(w, http.StatusConflict, "搜尋位置已更新，請重新搜尋")
	case errors.Is(err, ErrRoomNotFound):
		jsonError(w, http.StatusNotFound, "房間不存在")
	default:
		serverError(w, err, "資料庫錯誤，請稍後再試")
	}
	return true
}

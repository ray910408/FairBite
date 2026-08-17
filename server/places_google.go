package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log"
	"net/http"
	"sort"
	"strings"
	"sync"
	"time"
	"unicode"
)

// Places API (New) Nearby Search。快取條款：place_id 永存、其餘欄位 30 天內刷新
// （restaurants.fetched_at 把關，見 LoadCachedRestaurants）。
type googleProvider struct {
	apiKey  string
	baseURL string
	client  *http.Client
}

func NewGooglePlacesProvider(apiKey, baseURL string) PlacesProvider {
	if baseURL == "" {
		baseURL = "https://places.googleapis.com"
	}
	return &googleProvider{apiKey, baseURL, &http.Client{Timeout: 10 * time.Second}}
}

// Google type → 本專案 cuisine tags（詞彙見 CONTEXT.md）。
// 未列入者不產 tag，而沒有 tag 不是無害的：cuisine_filter 開啟時會被 engine.go 的
// kind "cuisine" 硬排除，素食成員面前會被 kind "dietary" 硬排除。所以「不對映」必須是
// 寫下理由的決定（googleTypesDeliberatelyUnmapped），不能是漏網。
// hamburger_restaurant 維持 western，不一律推定為速食；麥當勞另有 fast_food_restaurant，會同時取得兩個 tag。
var googleTypeTags = map[string][]string{
	"japanese_restaurant":   {"japanese"},
	"ramen_restaurant":      {"japanese", "ramen"},
	"sushi_restaurant":      {"japanese"}, // 原為 {"japanese", "sushi"}
	"korean_restaurant":     {"korean"},
	"cantonese_restaurant":  {"cantonese"},
	"dim_sum_restaurant":    {"cantonese", "dimsum"}, // dimsum 供 no_pork 硬排除比對（weights.go DietaryConflicts）
	"hot_pot_restaurant":    {"hotpot"},
	"indian_restaurant":     {"indian"}, // 原為 {"indian", "curry"}
	"seafood_restaurant":    {"seafood"},
	"steak_house":           {"steak", "western"},
	"american_restaurant":   {"western"},
	"italian_restaurant":    {"western"},
	"french_restaurant":     {"western"},
	"hamburger_restaurant":  {"western"},
	"fast_food_restaurant":  {"fast_food"},
	"pizza_restaurant":      {"western"},
	"dessert_restaurant":    {"dessert"},
	"ice_cream_shop":        {"dessert"},
	"dessert_shop":          {"dessert"},
	"sandwich_shop":         {"light_meal"},
	"salad_shop":            {"light_meal"},
	"deli":                  {"light_meal"},
	"cafe":                  {"light_meal"},
	"coffee_shop":           {"light_meal"},
	"breakfast_restaurant":  {"breakfast"},
	"brunch_restaurant":     {"breakfast"},
	"vegetarian_restaurant": {"vegetarian_friendly"},
	"vegan_restaurant":      {"vegetarian_friendly"},

	// 2026-08-16 普查補齊：以下 type 的菜系歸屬單一明確，不需要 query match 補救。
	// taiwanese_restaurant 是本次最大缺口——259 家樣本中 64 家帶此 type，
	// 其中 40 家（63%）沒有 chinese_restaurant，現行對映完全撈不到。
	"taiwanese_restaurant":        {"taiwanese"},
	"western_restaurant":          {"western"},
	"european_restaurant":         {"western"},
	"japanese_izakaya_restaurant": {"japanese"},
	"yakiniku_restaurant":         {"japanese"},
	"japanese_curry_restaurant":   {"japanese"}, // 不加 curry：見本 step 下半，curry 沒有消費端
}

// googleTypesDeliberatelyUnmapped：觀測到但刻意不產 canonical tag 的 Google type。
// 兩類理由：(1) 該 type 涵蓋多個互斥菜系，產窄義 tag 就是猜——交由 ADR-0006 的房間層
// query match 承接；(2) CUISINE_OPTIONS 沒有對應選項，要新增屬產品決策不是對映疏漏。
// 這張表存在的意義是讓「不對映」變成寫下理由的決定，而不是靜默的漏網
// （tags_test.go TestObservedGoogleTypesAreMappedOrDeliberatelyUnmapped 把關）。
var googleTypesDeliberatelyUnmapped = map[string]string{
	"noodle_shop":               "台式麵店與拉麵店共用此 type（ADR-0006 明列此例）；廣義訊號不產窄義 tag",
	"chinese_noodle_restaurant": "同 noodle_shop：台/中/港麵食共用",
	"chinese_restaurant":       "2026-08-16 實測 165 家：15% 台菜、14% 港式、72% 無從分辨——" +
		"精確訊號改用 taiwanese_restaurant，餘者交由 query match",
	"asian_restaurant":          "涵蓋全亞洲，無對應窄義 cuisine",
	"bistro":                    "2026-08-16 實測含韓式酒館、法式小館、台式餐酒館——無單一歸屬",
	"dumpling_restaurant":       "台式水餃與上海小籠共用",
	"cafeteria":                 "自助餐，菜系不定",
	"buffet_restaurant":         "吃到飽，菜系不定",
	"chicken_restaurant":        "鹹酥雞、美式炸雞、雞湯共用，無對應 cuisine option",
	"chicken_wings_restaurant":  "同 chicken_restaurant",
	"kebab_shop":                "無對應 cuisine option",
	"bar":                       "非供餐場所；meal gate 已擋，這裡只是登記已看過",
	"thai_restaurant":           "CUISINE_OPTIONS 無泰式；新增選項屬產品決策",
	"malaysian_restaurant":      "同 thai_restaurant",
	"australian_restaurant":     "同 thai_restaurant",
	"hawaiian_restaurant":       "同 thai_restaurant",
	"pakistani_restaurant":      "與 indian 菜系相鄰但不同源，不擅自併入",
	"restaurant":                "Google 的通用餐飲分類，不帶菜系訊號",
	"food":                      "同 restaurant：通用分類",
	"point_of_interest":         "Google 的地點通用分類，與餐飲無關",
	"establishment":             "同 point_of_interest：通用分類",
}

// Google 的 includedTypes 會比對所有 types；只有 primaryType 能表示場所的主要用途。
// 這份正面表列只收能構成一餐的供餐場所：正餐場域、熟食專賣，及提供完整餐點的外帶。
// 2026-08-12 擁有者決定納入「吃冰／甜點」目的地，因此明列非 _restaurant 的甜品店與冰淇淋店。
// 2026-08-12 擁有者再決定咖啡店算輕食，cafe/coffee_shop 一併納入並標 light_meal；
// 已知代價：不供餐的純咖啡吧也會成為候選，這是擁有者接受的取捨，不是遺漏。
// bakery、bar 仍刻意排除；擁有者未要求納入，這是產品判斷，不是遺漏。
// meal_delivery、pizza_delivery 也刻意排除：本產品是內用／前往取餐導向，會計算交通時間並導航。
var googleMealPrimaryTypes = map[string]struct{}{
	"bar_and_grill":  {},
	"bistro":         {},
	"cafe":           {},
	"cafeteria":      {},
	"coffee_shop":    {},
	"deli":           {},
	"dessert_shop":   {},
	"diner":          {},
	"food_court":     {},
	"hot_dog_stand":  {},
	"ice_cream_shop": {},
	"kebab_shop":     {},
	"meal_takeaway":  {},
	"noodle_shop":    {},
	"salad_shop":     {},
	"sandwich_shop":  {},
	"steak_house":    {},
}

// request 端 blocklist 只負責在 Google 套用 20 筆上限前提高名額效率，不是正確性判準。
// 清單刻意可以不完整；漏網者仍由 gIsMealPrimaryType 這個唯一正確性閘門 fail-closed。
// 不可改成 includedPrimaryTypes：Google 上限為 50，而允許的餐飲 primary types 遠超過上限。
var googleRequestExcludedPrimaryTypes = []string{
	"hypermarket",
	"hotel",
	"store",
	"supermarket",
	"department_store",
	"convenience_store",
	"grocery_store",
	"shopping_mall",
}

var gPriceLevels = map[string]int{
	"PRICE_LEVEL_FREE": 0, "PRICE_LEVEL_INEXPENSIVE": 1, "PRICE_LEVEL_MODERATE": 2,
	"PRICE_LEVEL_EXPENSIVE": 3, "PRICE_LEVEL_VERY_EXPENSIVE": 4,
}

type gPoint struct {
	Day, Hour, Minute int
}

type gPlace struct {
	ID             string `json:"id"`
	BusinessStatus string `json:"businessStatus"`
	PrimaryType    string `json:"primaryType"`
	DisplayName    struct {
		Text string `json:"text"`
	} `json:"displayName"`
	Types      []string `json:"types"`
	PriceLevel string   `json:"priceLevel"`
	Location   struct {
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
	} `json:"location"`
	FormattedAddress     string  `json:"formattedAddress"`
	Rating               float64 `json:"rating"`
	ServesVegetarianFood bool    `json:"servesVegetarianFood"`
	RegularOpeningHours  struct {
		Periods []struct {
			Open  gPoint  `json:"open"`
			Close *gPoint `json:"close"`
		} `json:"periods"`
	} `json:"regularOpeningHours"`
}

func (*googleProvider) Source() string { return "google" }

func (g *googleProvider) call(ctx context.Context, lat, lng float64, radiusM int) (PlacesSearchResult, error) {
	body := map[string]any{
		// includedTypes 只擴大 Google 的召回範圍；正確性仍由 gIsMealPrimaryType 單一把關，
		// 多列幾個類型不會放寬正確性閘門。反過來，沒列進來的類型只要店家 types 裡沒有
		// restaurant 就會被這道 request 端過濾擋掉，永遠進不了候選——所以映射到 light_meal
		// 與 dessert 的非 _restaurant 類型全部要列。
		"includedTypes":        []string{"restaurant", "ice_cream_shop", "dessert_shop", "cafe", "coffee_shop", "sandwich_shop", "salad_shop", "deli"},
		"excludedPrimaryTypes": googleRequestExcludedPrimaryTypes,
		"maxResultCount":       20, // API 上限
		"languageCode":         "zh-TW",
		"locationRestriction": map[string]any{
			"circle": map[string]any{
				"center": map[string]float64{"latitude": lat, "longitude": lng},
				"radius": float64(radiusM),
			},
		},
	}
	places, rejected, err := g.fetchPlaces(ctx, "/v1/places:searchNearby", body)
	if err != nil {
		return PlacesSearchResult{}, err
	}
	result := PlacesSearchResult{Restaurants: make([]Restaurant, 0, len(places)), RejectedPlaceIDs: rejected}
	for _, p := range places {
		result.Restaurants = append(result.Restaurants, gRestaurant(p))
	}
	return result, nil
}

// fetchPlaces：對指定 endpoint 發請求並 parse＋meal gate。nearby 與 textSearch 共用。
// eng review 2A：只回原始 gPlace（gate 後），轉換交給 gRestaurant——不維護平行陣列對齊。
func (g *googleProvider) fetchPlaces(ctx context.Context, endpoint string, body map[string]any) ([]gPlace, []string, error) {
	payload, _ := json.Marshal(body)
	req, err := http.NewRequestWithContext(ctx, "POST", g.baseURL+endpoint, bytes.NewReader(payload))
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Goog-Api-Key", g.apiKey)
	req.Header.Set("X-Goog-FieldMask",
		"places.id,places.displayName,places.types,places.primaryType,places.priceLevel,places.location,"+
			"places.formattedAddress,places.rating,places.businessStatus,places.regularOpeningHours,places.servesVegetarianFood")
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, nil, fmt.Errorf("places api status %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	var out struct {
		Places []gPlace `json:"places"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, nil, err
	}
	kept := out.Places[:0]
	var rejected []string
	unknown := map[string]bool{}
	untagged := 0
	for _, p := range out.Places {
		if !gIsMealPrimaryType(p.PrimaryType) {
			rejected = append(rejected, p.ID)
			continue
		}
		// 兩道 runtime 回饋，回答不同問題（eng review D2／T2）。
		// (1) 未分類的 type：警報。穩態靜音，一出現就代表 tags_test.go 的 census 過期了——
		//     census 是手抄快照，擋不到 Google 之後新增的 type，那正是 TODOS.md:22 假結案的形狀。
		for _, gt := range p.Types {
			if _, mapped := googleTypeTags[gt]; mapped {
				continue
			}
			if _, waived := googleTypesDeliberatelyUnmapped[gt]; waived {
				continue
			}
			unknown[gt] = true
		}
		// (2) 零 tag 家數：健康度。含刻意不對映的類型（麵店等），所以每次都會有數字——
		//     它量的是「刻意不對映的實際代價」，將來要不要把 noodle_shop 拉進來有數據可講。
		if len(gTags(p)) == 0 {
			untagged++
		}
		kept = append(kept, p)
	}
	if len(rejected) > 0 {
		log.Printf("primaryType 過濾掉 %d 筆非餐廳", len(rejected))
	}
	if untagged > 0 {
		log.Printf("零 cuisine tag %d/%d 筆（含刻意不對映；勾任何菜系都選不到，cuisine_filter 開啟時被硬排除）", untagged, len(kept))
	}
	if len(unknown) > 0 {
		keys := make([]string, 0, len(unknown))
		for gt := range unknown {
			keys = append(keys, gt)
		}
		sort.Strings(keys) // 決定性輸出，log 才好比對
		log.Printf("未分類的 Google type %v——補進 googleTypeTags 或 googleTypesDeliberatelyUnmapped，並更新 tags_test.go 的 observedGoogleTypes", keys)
	}
	return kept, rejected, nil
}

// gRestaurant：gPlace → Restaurant 的唯一轉換點（自現 call 的 parse 迴圈抽出，欄位不變）。
func gRestaurant(p gPlace) Restaurant {
	closed := p.BusinessStatus == "CLOSED_TEMPORARILY" || p.BusinessStatus == "CLOSED_PERMANENTLY"
	return Restaurant{
		PlaceID: p.ID, Closed: closed, Name: p.DisplayName.Text, PrimaryType: p.PrimaryType,
		CuisineTags: gTags(p), PriceLevel: gPrice(p.PriceLevel),
		Lat: p.Location.Latitude, Lng: p.Location.Longitude,
		Address: p.FormattedAddress, Hours: gHours(p), Rating: p.Rating,
	}
}

// gHasMealEvidence：types 含任何供餐正向證據（tier2 防護用；spec 決策 #9）。
var gMealEvidenceTypes = map[string]bool{
	"noodle_shop": true, "food_court": true, "diner": true, "bistro": true,
	"cafeteria": true, "steak_house": true, "meal_takeaway": true,
}

func gHasMealEvidence(types []string) bool {
	for _, t := range types {
		if t == "restaurant" || strings.HasSuffix(t, "_restaurant") || gMealEvidenceTypes[t] {
			return true
		}
	}
	return false
}

// gRejectQueryMatch：條件式衝突防護（spec 決策 #9）。回 true = 拒收該筆 query match
// （店仍保留為一般候選，只是不帶這個菜系證據）。
func gRejectQueryMatch(cuisine string, p gPlace) bool {
	if !HotMealCuisines[cuisine] {
		return false
	}
	if DessertOnlyPrimaryTypes[p.PrimaryType] {
		return true // tier1：甜品專門店標熱食＝明顯荒謬
	}
	if LightDrinkPrimaryTypes[p.PrimaryType] && !gHasMealEvidence(p.Types) {
		return true // tier2：純輕飲、無任何供餐證據
	}
	return false
}

// textSearch：單一菜系的定向檢索。locationBias 圓形非硬性範圍（searchText 的
// locationRestriction 只支援矩形），radiusM 外的結果以 haversine 硬過濾，
// 維持 fetch envelope 語意（spec §5.1）。
func (g *googleProvider) textSearch(ctx context.Context, cuisine, query string, lat, lng float64, radiusM int) ([]Restaurant, []string, error) {
	body := map[string]any{
		// eng review 6：相關性尾段是弱匹配，15 名保真剪雜訊（池子上限與投票體驗的取捨）
		"textQuery": query, "languageCode": "zh-TW", "pageSize": 15,
		"locationBias": map[string]any{
			"circle": map[string]any{
				"center": map[string]float64{"latitude": lat, "longitude": lng},
				"radius": float64(radiusM),
			},
		},
	}
	places, rejected, err := g.fetchPlaces(ctx, "/v1/places:searchText", body)
	if err != nil {
		return nil, nil, err
	}
	var kept []Restaurant
	for _, p := range places {
		r := gRestaurant(p)
		if Haversine(lat, lng, r.Lat, r.Lng) > float64(radiusM) {
			continue
		}
		if !gRejectQueryMatch(cuisine, p) {
			r.QueryMatches = []string{cuisine}
		}
		kept = append(kept, r)
	}
	return kept, rejected, nil
}

// handleSearch（host 按「開始搜尋餐廳」）          Google Places API (New)
//   │ members(call-time) → cuisineUnion(K 個菜系)
//   ▼
// SearchNearby(lat, lng, radiusM, cuisines)
//   ├─ searchNearby ────────────────────────────► 20 筆熱門（圓形 locationRestriction）
//   │    └─ 失敗（重試×2 後）→ 取消在途 text → 整體 error → handler 走 30 天快取 fallback（text 結果全棄）
//   ├─ ∥ textSearch("拉麵") ─────────────────────► ≤15 筆語意相關（pageSize 15，eng review 6）
//   ├─ ∥ textSearch("火鍋") … K 支並行 ──────────►（locationBias 圓＋haversine 硬過濾 radiusM 外）
//   │    ├─ meal gate：gIsMealPrimaryType fail-closed（拒者入 RejectedPlaceIDs）
//   │    ├─ 衝突防護：tier1 甜品專門型拒 match／tier2 純輕飲無供餐證據拒 match（店保留、match 不標）
//   │    └─ 失敗（重試×2 後）→ log 容忍，其餘支照常（部分成功不降級）
//   ▼
// merge by place_id：QueryMatches 聯集；RejectedPlaceIDs 聯集去重
//   → dedupeChains：同 chainKey（連鎖）只留離圓心最近分店、matches 聯集（不進 Rejected；落選歇業分店→DiscardedClosed 供 tombstone）
//   → QueryMatches sort（決定性）
//   ▼
// closed→tombstone／rejected→逐出 ▶ 快取交易先 commit（restaurants upsert；QueryMatches 不落快取）
//   ▼
// 候選交易：freeze（tx 內重讀 cuisine_filter＋成員、半徑收斂）
//   → Evaluate（memberLikes = tags ∪ query_matches；cuisine_filter=true 時菜系為硬性條件 kind "cuisine"）
//   → ReplaceCandidates（query_matches 隨 kept/excluded 列落 room_candidates）→ rescore/draw 讀同欄位回圈
func (g *googleProvider) SearchNearby(ctx context.Context, lat, lng float64, radiusM int, cuisines []string) (PlacesSearchResult, error) {
	textCtx, cancelText := context.WithCancel(ctx)
	defer cancelText()
	type textOut struct {
		rs       []Restaurant
		rejected []string
	}
	var (
		base    PlacesSearchResult
		baseErr error
		outs    = make([]textOut, len(cuisines))
		wg      sync.WaitGroup
	)
	// eng review D8（codex #8 收束）：nearby 與 text 同時發車——總延遲才真正≈最慢一支。
	// 失敗語意不變：nearby 敗（重試後）即整場敗、text 結果丟棄（spec §7 骨幹語意）。
	wg.Add(1)
	go func() {
		defer wg.Done()
		for attempt := 0; attempt < 2; attempt++ { // spec §8：失敗重試一次
			rs, err := g.call(ctx, lat, lng, radiusM)
			if err == nil {
				base, baseErr = rs, nil
				return
			}
			baseErr = err
		}
		cancelText()
	}()
	for i, c := range cuisines {
		q, ok := CuisineSearchQueries[c]
		if !ok {
			continue // 沒有查詢詞的菜系（防未來 key 漂移）：只靠 nearby＋types
		}
		wg.Add(1)
		go func(i int, cuisine, query string) {
			defer wg.Done()
			for attempt := 0; attempt < 2; attempt++ {
				if textCtx.Err() != nil {
					return
				}
				rs, rejected, err := g.textSearch(textCtx, cuisine, query, lat, lng, radiusM)
				if err == nil {
					outs[i] = textOut{rs, rejected}
					return
				}
				if textCtx.Err() != nil {
					return
				}
				if attempt == 1 && !errors.Is(err, context.Canceled) {
					// 單支定向檢索失敗只容忍不降級（spec §7）：nearby 池仍在，缺的只是該菜系的補召回
					log.Printf("text search %q failed after retry: %v", cuisine, err)
				}
			}
		}(i, c, q)
	}
	wg.Wait()
	if baseErr != nil {
		// nearby 是骨幹：失敗即整體失敗，走既有 30 天快取 fallback（spec §7）；text 結果不單獨救場
		return PlacesSearchResult{}, baseErr
	}
	byPlaceID := make(map[string]int, len(base.Restaurants))
	for i := range base.Restaurants {
		byPlaceID[base.Restaurants[i].PlaceID] = i
	}
	rejectedSeen := map[string]bool{}
	for _, id := range base.RejectedPlaceIDs {
		rejectedSeen[id] = true
	}
	for _, o := range outs {
		for _, r := range o.rs {
			if idx, ok := byPlaceID[r.PlaceID]; ok {
				// 既有列：併入 query match（union，避免重複）
				for _, m := range r.QueryMatches {
					if !hasTag(base.Restaurants[idx].QueryMatches, m) {
						base.Restaurants[idx].QueryMatches = append(base.Restaurants[idx].QueryMatches, m)
					}
				}
				continue
			}
			byPlaceID[r.PlaceID] = len(base.Restaurants)
			base.Restaurants = append(base.Restaurants, r)
		}
		for _, id := range o.rejected {
			if !rejectedSeen[id] {
				rejectedSeen[id] = true
				base.RejectedPlaceIDs = append(base.RejectedPlaceIDs, id)
			}
		}
	}
	base.Restaurants, base.DiscardedClosedPlaceIDs = dedupeChains(base.Restaurants, lat, lng)
	for i := range base.Restaurants {
		sort.Strings(base.Restaurants[i].QueryMatches) // 決定性輸出，測試與 trace 穩定
	}
	return base, nil
}

// chainKey：連鎖分店分組鍵（eng review 6 裁定；heuristic）。
// dash／括號裁切寧漏勿誤殺；空格裁切對共用 2 字 CJK 前綴的不同品牌有誤併風險（已知取捨）。
// 規則：砍第一個 -／－／(／（ 之後；再者若首段為 ≥2 個 CJK 字元且後接空格，砍空格後
// （「麥當勞-台北民生餐廳」→「麥當勞」、「丸龜製麵 台北車站店」→「丸龜製麵」）。
// 英文名不做空格裁切（「Burger King」不可變「Burger」）。分不到組的連鎖保留原樣。
func chainKey(name string) string {
	if i := strings.IndexAny(name, "-－(（"); i >= 0 {
		cut := strings.TrimSpace(name[:i])
		// 防英文名誤併（Mo-Mo-Paradise ≠「Mo」）：裁切結果須含 CJK 才採用
		if strings.ContainsFunc(cut, func(r rune) bool { return unicode.Is(unicode.Han, r) }) {
			name = cut
		}
	}
	name = strings.TrimSpace(name)
	if i := strings.IndexByte(name, ' '); i >= 2 {
		head := name[:i]
		cjk := 0
		for _, r := range head {
			if !unicode.Is(unicode.Han, r) {
				cjk = 0
				break
			}
			cjk++
		}
		if cjk >= 2 {
			name = head
		}
	}
	return name
}

// dedupeChains：同 chainKey 只留一家分店；query_matches 取聯集。
// 被去重的分店不是壞店——絕不能進 RejectedPlaceIDs（會被 tombstone 逐出快取）。
// eng review D4（codex #1 收束）兩道防線：
//
//	(1) 選店優先「非歇業」再比距離——歇業店稍後會被 closed 過濾丟掉，選它＝整組連鎖消失；
//	(2) 繼承的 match 以留存分店自身 primaryType 重跑 tier1——甜品專門分店不得因姐妹店帶熱食證據
//	   （tier2 需 gPlace.Types，此處無從重跑；同連鎖輕飲分店繼承熱食 match 的殘風險接受並記錄）。
func dedupeChains(rs []Restaurant, lat, lng float64) ([]Restaurant, []string) {
	nearest := map[string]int{} // chainKey → out 內留存者 index
	out := rs[:0]
	var discardedClosed []string
	for _, r := range rs {
		key := chainKey(r.Name)
		idx, seen := nearest[key]
		if !seen {
			nearest[key] = len(out)
			out = append(out, r)
			continue
		}
		keep := &out[idx]
		better := (keep.Closed && !r.Closed) ||
			(keep.Closed == r.Closed &&
				Haversine(lat, lng, r.Lat, r.Lng) < Haversine(lat, lng, keep.Lat, keep.Lng))
		if better {
			r.QueryMatches = append(r.QueryMatches, keep.QueryMatches...)
			if keep.Closed {
				discardedClosed = append(discardedClosed, keep.PlaceID)
			}
			*keep = r
		} else {
			keep.QueryMatches = append(keep.QueryMatches, r.QueryMatches...)
			if r.Closed {
				discardedClosed = append(discardedClosed, r.PlaceID)
			}
		}
	}
	for i := range out {
		out[i].QueryMatches = filterInheritedMatches(out[i].PrimaryType, dedupeStrings(out[i].QueryMatches))
	}
	return out, discardedClosed
}

// filterInheritedMatches：tier1 再把關——熱食 match 不得掛在甜品專門型留存分店上。
// filterInheritedMatches 會破壞性原地改寫 matches 的底層陣列；呼叫端不得再持有原 slice。
func filterInheritedMatches(primaryType string, matches []string) []string {
	out := matches[:0]
	for _, c := range matches {
		if HotMealCuisines[c] && DessertOnlyPrimaryTypes[primaryType] {
			continue
		}
		out = append(out, c)
	}
	return out
}

// dedupeStrings 會破壞性原地改寫 ss 的底層陣列；呼叫端不得再持有原 slice。
func dedupeStrings(ss []string) []string {
	seen := map[string]bool{}
	out := ss[:0]
	for _, s := range ss {
		if !seen[s] {
			seen[s] = true
			out = append(out, s)
		}
	}
	return out
}

func gIsMealPrimaryType(primaryType string) bool {
	if primaryType == "restaurant" || strings.HasSuffix(primaryType, "_restaurant") {
		return true
	}
	_, ok := googleMealPrimaryTypes[primaryType]
	return ok
}

func gTags(p gPlace) []string {
	seen := map[string]bool{}
	tags := []string{}
	add := func(t string) {
		if !seen[t] {
			seen[t] = true
			tags = append(tags, t)
		}
	}
	for _, gt := range p.Types {
		for _, t := range googleTypeTags[gt] {
			add(t)
		}
	}
	if p.ServesVegetarianFood {
		add("vegetarian_friendly")
	}
	return tags
}

// 未對映或未提供價位 → PriceLevelUnknown；未知價位不參與預算硬排除。
func gPrice(level string) int {
	if v, ok := gPriceLevels[level]; ok {
		return v
	}
	return PriceLevelUnknown
}

func gHours(p gPlace) OpeningHours {
	oh := OpeningHours{}
	for _, period := range p.RegularOpeningHours.Periods {
		if period.Close == nil { // 24/7：Google 以單一 open{day:0,hour:0} 無 close 表示
			for _, k := range weekdayKeys {
				oh[k] = [][2]int{{0, 1440}}
			}
			return oh
		}
		openDay, closeDay := period.Open.Day, period.Close.Day
		openMin := period.Open.Hour*60 + period.Open.Minute
		closeMin := period.Close.Hour*60 + period.Close.Minute
		delta := (closeDay - openDay + len(weekdayKeys)) % len(weekdayKeys)
		if delta == 0 {
			oh[weekdayKeys[openDay]] = append(oh[weekdayKeys[openDay]], [2]int{openMin, closeMin})
			continue
		}
		if delta == 1 && closeMin <= openMin {
			// 精簡跨夜格式須保留在 open day，供 MinutesUntilClose carry-over 邏輯使用。
			oh[weekdayKeys[openDay]] = append(oh[weekdayKeys[openDay]], [2]int{openMin, closeMin})
			continue
		}
		oh[weekdayKeys[openDay]] = append(oh[weekdayKeys[openDay]], [2]int{openMin, 1440})
		for offset := 1; offset < delta; offset++ {
			day := (openDay + offset) % len(weekdayKeys)
			oh[weekdayKeys[day]] = append(oh[weekdayKeys[day]], [2]int{0, 1440})
		}
		if closeMin != 0 {
			oh[weekdayKeys[closeDay]] = append(oh[weekdayKeys[closeDay]], [2]int{0, closeMin})
		}
	}
	return oh
}

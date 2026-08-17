package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestGoogleHoursMultiDayClosingAtMidnight(t *testing.T) {
	var place gPlace
	if err := json.Unmarshal([]byte(`{"regularOpeningHours":{"periods":[{"open":{"day":5,"hour":17,"minute":0},"close":{"day":0,"hour":0,"minute":0}}]}}`), &place); err != nil {
		t.Fatal(err)
	}
	hours := gHours(place)
	for _, tc := range []struct {
		name string
		at   time.Time
		open bool
	}{
		{"週六中午", at(time.Saturday, 12, 0), true},
		{"週六午夜前", at(time.Saturday, 23, 59), true},
		{"週日凌晨", at(time.Sunday, 0, 30), false},
		{"週日中午", at(time.Sunday, 12, 0), false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := hours.IsOpenAt(tc.at); got != tc.open {
				t.Fatalf("IsOpenAt() = %v, want %v; hours=%v", got, tc.open, hours)
			}
		})
	}
}

const gSample = `{"places":[
  {"id":"gp-1","primaryType":"sushi_restaurant","displayName":{"text":"山本壽司"},
   "businessStatus":"OPERATIONAL",
   "types":["sushi_restaurant","japanese_restaurant","restaurant"],
   "priceLevel":"PRICE_LEVEL_MODERATE",
   "location":{"latitude":25.0478,"longitude":121.5170},
   "formattedAddress":"台北市中正區某路1號","rating":4.3,
   "servesVegetarianFood":false,
   "regularOpeningHours":{"periods":[
     {"open":{"day":1,"hour":11,"minute":0},"close":{"day":1,"hour":22,"minute":30}}]}},
  {"id":"gp-2","primaryType":"restaurant","displayName":{"text":"深夜食堂"},
   "types":["restaurant"],
   "location":{"latitude":25.0480,"longitude":121.5175},
   "formattedAddress":"台北市中正區某路2號","rating":4.0,
   "servesVegetarianFood":true,
   "regularOpeningHours":{"periods":[
     {"open":{"day":5,"hour":17,"minute":0},"close":{"day":6,"hour":2,"minute":0}}]}},
  {"id":"gp-3","primaryType":"breakfast_restaurant","displayName":{"text":"全日早餐"},
   "types":["breakfast_restaurant"],
   "priceLevel":"PRICE_LEVEL_INEXPENSIVE",
   "location":{"latitude":25.0470,"longitude":121.5160},
   "formattedAddress":"台北市中正區某路3號","rating":3.9,
   "regularOpeningHours":{"periods":[{"open":{"day":0,"hour":0,"minute":0}}]}},
  {"id":"gp-4","primaryType":"restaurant","displayName":{"text":"週末長時段餐廳"},
   "types":["restaurant"],
   "priceLevel":"PRICE_LEVEL_INEXPENSIVE",
   "location":{"latitude":25.0472,"longitude":121.5162},
   "formattedAddress":"台北市中正區某路4號","rating":4.1,
   "regularOpeningHours":{"periods":[
     {"open":{"day":5,"hour":10,"minute":0},"close":{"day":6,"hour":12,"minute":0}}]}},
  {"id":"gp-5","primaryType":"restaurant","displayName":{"text":"跨週末餐廳"},
    "types":["restaurant"],
    "priceLevel":"PRICE_LEVEL_INEXPENSIVE",
    "location":{"latitude":25.0474,"longitude":121.5164},
    "formattedAddress":"台北市中正區某路5號","rating":4.2,
    "regularOpeningHours":{"periods":[
      {"open":{"day":5,"hour":17,"minute":0},"close":{"day":0,"hour":2,"minute":0}}]}},
  {"id":"gp-6","primaryType":"restaurant","displayName":{"text":"營業時間未知餐廳"},
    "types":["restaurant"],
    "priceLevel":"PRICE_LEVEL_INEXPENSIVE",
    "location":{"latitude":25.0476,"longitude":121.5166},
    "formattedAddress":"台北市中正區某路6號","rating":4.0},
  {"id":"gp-7","primaryType":"restaurant","displayName":{"text":"Closed Restaurant"},
    "businessStatus":"CLOSED_PERMANENTLY",
    "types":["restaurant"],
    "priceLevel":"PRICE_LEVEL_INEXPENSIVE",
    "location":{"latitude":25.0477,"longitude":121.5167},
    "formattedAddress":"Taipei","rating":4.8,
    "regularOpeningHours":{"periods":[
      {"open":{"day":1,"hour":0,"minute":0}}]}},
  {"id":"gp-hypermarket","primaryType":"hypermarket","displayName":{"text":"唐吉訶德式商場"},
    "types":["hypermarket","restaurant"],
    "location":{"latitude":25.0479,"longitude":121.5171}},
  {"id":"gp-hotel","primaryType":"hotel","displayName":{"text":"附餐旅館"},
    "types":["hotel","restaurant"],
    "location":{"latitude":25.0481,"longitude":121.5172}},
  {"id":"gp-noodle","primaryType":"noodle_shop","displayName":{"text":"麵線店"},
    "types":["noodle_shop","restaurant"],
    "location":{"latitude":25.0482,"longitude":121.5173}},
  {"id":"gp-missing-primary","displayName":{"text":"未知主類型"},
    "types":["restaurant"],
    "location":{"latitude":25.0483,"longitude":121.5174}}
]}`

func TestCuisinePrimaryTypeProductBoundaries(t *testing.T) {
	for _, primaryType := range []string{"meal_delivery", "pizza_delivery"} {
		if gIsMealPrimaryType(primaryType) {
			t.Errorf("%s 是純外送類型，不得進入前往用餐候選", primaryType)
		}
	}
	if !gIsMealPrimaryType("meal_takeaway") {
		t.Error("meal_takeaway 有可前往取餐的地點，仍應保留")
	}
	for _, primaryType := range []string{"dessert_restaurant", "ice_cream_shop", "dessert_shop"} {
		if !gIsMealPrimaryType(primaryType) {
			t.Errorf("擁有者決定納入甜點候選，%s 必須保留", primaryType)
		}
	}
	for _, primaryType := range []string{"cafe", "coffee_shop"} {
		if !gIsMealPrimaryType(primaryType) {
			t.Errorf("擁有者決定咖啡店算輕食，%s 必須保留", primaryType)
		}
	}
	for _, primaryType := range []string{"bakery", "bar"} {
		if gIsMealPrimaryType(primaryType) {
			t.Errorf("未納入的邊界類型 %s 必須維持排除", primaryType)
		}
	}
}

func TestCuisineTagsFastFoodDessertAndLightMeal(t *testing.T) {
	tests := []struct {
		name  string
		types []string
		want  []string
	}{
		{
			name:  "麥當勞同時是速食與西式",
			types: []string{"fast_food_restaurant", "hamburger_restaurant", "american_restaurant"},
			want:  []string{"fast_food", "western"},
		},
		{name: "甜點餐廳", types: []string{"dessert_restaurant"}, want: []string{"dessert"}},
		{name: "冰淇淋店", types: []string{"ice_cream_shop"}, want: []string{"dessert"}},
		{name: "甜品店", types: []string{"dessert_shop"}, want: []string{"dessert"}},
		{name: "三明治店", types: []string{"sandwich_shop"}, want: []string{"light_meal"}},
		{name: "沙拉店", types: []string{"salad_shop"}, want: []string{"light_meal"}},
		{name: "熟食店", types: []string{"deli"}, want: []string{"light_meal"}},
		{name: "咖啡店", types: []string{"cafe"}, want: []string{"light_meal"}},
		{name: "咖啡吧", types: []string{"coffee_shop", "cafe"}, want: []string{"light_meal"}},
		{name: "早餐店", types: []string{"breakfast_restaurant"}, want: []string{"breakfast"}},
		{name: "早午餐店", types: []string{"brunch_restaurant"}, want: []string{"breakfast"}},
	}
	for _, tc := range tests {
		t.Run(tc.name, func(t *testing.T) {
			tags := gTags(gPlace{Types: tc.types})
			for _, want := range tc.want {
				if !hasTag(tags, want) {
					t.Errorf("types %v 應產生 %q，got %v", tc.types, want, tags)
				}
			}
		})
	}
}

func TestGRestaurantKeepsEmptyCuisineTagsAsNonNilSlice(t *testing.T) {
	r := gRestaurant(gPlace{PrimaryType: "restaurant"})
	if r.CuisineTags == nil || len(r.CuisineTags) != 0 {
		t.Fatalf("無 type 命中時 CuisineTags 必須是非 nil 空 slice，got %#v", r.CuisineTags)
	}
}

func TestDimSumRestaurantTagsIncludeCuisineAndDietaryConflict(t *testing.T) {
	tags := gTags(gPlace{Types: []string{"dim_sum_restaurant"}})
	for _, want := range []string{"cantonese", "dimsum"} {
		if !hasTag(tags, want) {
			t.Errorf("dim_sum_restaurant 應產生 %q，got %v", want, tags)
		}
	}
}

func gServer(t *testing.T, fail1st bool) *httptest.Server {
	t.Helper()
	var calls atomic.Int32
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/places:searchNearby" {
			t.Errorf("unexpected path %s", r.URL.Path)
		}
		if r.Header.Get("X-Goog-Api-Key") == "" || r.Header.Get("X-Goog-FieldMask") == "" {
			t.Error("缺 API key 或 FieldMask header")
		}
		if !strings.Contains(r.Header.Get("X-Goog-FieldMask"), "places.businessStatus") {
			t.Errorf("FieldMask missing places.businessStatus: %q", r.Header.Get("X-Goog-FieldMask"))
		}
		if !strings.Contains(r.Header.Get("X-Goog-FieldMask"), "places.primaryType") {
			t.Errorf("FieldMask missing places.primaryType: %q", r.Header.Get("X-Goog-FieldMask"))
		}
		var requestBody struct {
			IncludedTypes        []string `json:"includedTypes"`
			ExcludedPrimaryTypes []string `json:"excludedPrimaryTypes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Errorf("decode request body: %v", err)
		}
		included := make(map[string]bool, len(requestBody.IncludedTypes))
		for _, placeType := range requestBody.IncludedTypes {
			included[placeType] = true
		}
		if len(requestBody.IncludedTypes) != 8 {
			t.Errorf("request includedTypes = %v, want exactly restaurant, ice_cream_shop, dessert_shop, cafe, coffee_shop, sandwich_shop, salad_shop, deli", requestBody.IncludedTypes)
		}
		for _, placeType := range []string{
			"restaurant", "ice_cream_shop", "dessert_shop", "cafe", "coffee_shop",
			"sandwich_shop", "salad_shop", "deli",
		} {
			if !included[placeType] {
				t.Errorf("request includedTypes missing %q: %v", placeType, requestBody.IncludedTypes)
			}
		}
		excluded := make(map[string]bool, len(requestBody.ExcludedPrimaryTypes))
		for _, primaryType := range requestBody.ExcludedPrimaryTypes {
			excluded[primaryType] = true
		}
		for _, primaryType := range []string{
			"hypermarket", "hotel", "store", "supermarket", "department_store",
			"convenience_store", "grocery_store", "shopping_mall",
		} {
			if !excluded[primaryType] {
				t.Errorf("request excludedPrimaryTypes missing %q: %v", primaryType, requestBody.ExcludedPrimaryTypes)
			}
		}
		if fail1st && calls.Add(1) == 1 {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Write([]byte(gSample))
	}))
}

func TestGoogleProviderMapping(t *testing.T) {
	srv := gServer(t, false)
	defer srv.Close()
	p := NewGooglePlacesProvider("test-key", srv.URL)
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, nil)
	if err != nil || len(result.Restaurants) != 8 {
		t.Fatalf("want 8 restaurants, got %d err %v", len(result.Restaurants), err)
	}
	byPID := map[string]Restaurant{}
	for _, r := range result.Restaurants {
		byPID[r.PlaceID] = r
	}
	for _, excludedID := range []string{"gp-hypermarket", "gp-hotel", "gp-missing-primary"} {
		if _, ok := byPID[excludedID]; ok {
			t.Errorf("primaryType 不符合餐廳正面表列的 %s 必須排除", excludedID)
		}
	}
	if _, ok := byPID["gp-noodle"]; !ok {
		t.Error("primaryType=noodle_shop 必須保留")
	}
	rejected := make(map[string]bool, len(result.RejectedPlaceIDs))
	for _, rejectedID := range result.RejectedPlaceIDs {
		rejected[rejectedID] = true
	}
	for _, rejectedID := range []string{"gp-hypermarket", "gp-hotel", "gp-missing-primary"} {
		if !rejected[rejectedID] {
			t.Errorf("client 端拒絕的 %s 必須回傳供快取逐出：%v", rejectedID, result.RejectedPlaceIDs)
		}
	}
	closed, ok := byPID["gp-7"]
	if !ok || !closed.Closed {
		t.Errorf("CLOSED_PERMANENTLY place must be returned with Closed=true: %+v", closed)
	}
	sushi, ok := byPID["gp-1"]
	if !ok {
		t.Fatal("OPERATIONAL place gp-1 must be kept")
	}
	if sushi.Closed {
		t.Error("OPERATIONAL place gp-1 must have Closed=false")
	}
	if sushi.Name != "山本壽司" || sushi.PriceLevel != 2 || sushi.Rating != 4.3 {
		t.Errorf("基本欄位對映錯誤：%+v", sushi)
	}
	if sushi.PrimaryType != "sushi_restaurant" {
		t.Errorf("primaryType 必須帶入快取判斷欄位，got %q", sushi.PrimaryType)
	}
	if !hasTag(sushi.CuisineTags, "japanese") {
		t.Errorf("types 應映到 japanese：%v", sushi.CuisineTags)
	}
	if !sushi.Hours.IsOpenAt(at(time.Monday, 12, 0)) || sushi.Hours.IsOpenAt(at(time.Monday, 23, 0)) {
		t.Error("一般營業時段轉換錯誤")
	}
	late := byPID["gp-2"]
	if !hasTag(late.CuisineTags, "vegetarian_friendly") {
		t.Errorf("servesVegetarianFood 應產 vegetarian_friendly：%v", late.CuisineTags)
	}
	if late.PriceLevel != PriceLevelUnknown {
		t.Errorf("缺 priceLevel 應為 PriceLevelUnknown，got %d", late.PriceLevel)
	}
	if !late.Hours.IsOpenAt(at(time.Saturday, 1, 0)) || late.Hours.IsOpenAt(at(time.Saturday, 3, 0)) {
		t.Error("跨夜時段轉換錯誤")
	}
	breakfast := byPID["gp-3"]
	if !breakfast.Hours.IsOpenAt(at(time.Wednesday, 4, 0)) {
		t.Error("無 close 的單一 period 應視為 24/7")
	}
	long := byPID["gp-4"]
	for _, tc := range []struct {
		name string
		at   time.Time
		open bool
	}{
		{"週五開門前", at(time.Friday, 9, 0), false},
		{"週五上午", at(time.Friday, 11, 0), true},
		{"週五深夜", at(time.Friday, 23, 30), true},
		{"週六上午", at(time.Saturday, 11, 0), true},
		{"週六關門後", at(time.Saturday, 13, 0), false},
	} {
		t.Run("multi-day/"+tc.name, func(t *testing.T) {
			if got := long.Hours.IsOpenAt(tc.at); got != tc.open {
				t.Errorf("IsOpenAt() = %v, want %v；hours=%v", got, tc.open, long.Hours)
			}
		})
	}
	weekend := byPID["gp-5"]
	for _, tc := range []struct {
		name string
		at   time.Time
		open bool
	}{
		{"週五開門前", at(time.Friday, 16, 0), false},
		{"週六中午", at(time.Saturday, 12, 0), true},
		{"週六深夜", at(time.Saturday, 23, 30), true},
		{"週日凌晨", at(time.Sunday, 1, 0), true},
		{"週日關門後", at(time.Sunday, 3, 0), false},
	} {
		t.Run("multi-day-close-before-open/"+tc.name, func(t *testing.T) {
			if got := weekend.Hours.IsOpenAt(tc.at); got != tc.open {
				t.Errorf("IsOpenAt() = %v, want %v；hours=%v", got, tc.open, weekend.Hours)
			}
		})
	}
	unknown, ok := byPID["gp-6"]
	if !ok {
		t.Fatal("place without businessStatus gp-6 must be kept")
	}
	if unknown.Closed {
		t.Error("place without businessStatus gp-6 must have Closed=false")
	}
	if len(unknown.Hours) != 0 {
		t.Errorf("缺 regularOpeningHours 應保留為未知（empty map），got %v", unknown.Hours)
	}
}

func TestGoogleProviderRetries(t *testing.T) {
	srv := gServer(t, true)
	defer srv.Close()
	p := NewGooglePlacesProvider("test-key", srv.URL)
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, nil)
	if err != nil || len(result.Restaurants) == 0 {
		t.Fatalf("第一次 500 應重試成功：err %v", err)
	}
}

func TestGoogleProviderErrorIncludesBodySnippet(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusForbidden)
		_, _ = w.Write([]byte(`{"error":{"message":"quota exceeded for this key"}}`))
	}))
	defer srv.Close()
	p := NewGooglePlacesProvider("test-key", srv.URL)
	_, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, nil)
	if err == nil || !strings.Contains(err.Error(), "quota exceeded for this key") {
		t.Fatalf("non-200 error 應含 response body snippet，got %v", err)
	}
}

const gFanoutNearby = `{"places":[
  {"id":"near-1","primaryType":"restaurant","displayName":{"text":"附近餐廳"},
   "types":["restaurant"],"location":{"latitude":25.0478,"longitude":121.5170}},
  {"id":"tx-2","primaryType":"restaurant","displayName":{"text":"重複餐廳"},
   "types":["restaurant"],"location":{"latitude":25.0479,"longitude":121.5171}}
]}`

const gFanoutRamen = `{"places":[
  {"id":"tx-1","primaryType":"noodle_shop","displayName":{"text":"麵框框"},
   "types":["noodle_shop"],"location":{"latitude":25.0478,"longitude":121.5170}},
  {"id":"tx-2","primaryType":"restaurant","displayName":{"text":"重複餐廳"},
   "types":["restaurant"],"location":{"latitude":25.0479,"longitude":121.5171}},
  {"id":"tx-3","primaryType":"dessert_shop","displayName":{"text":"甜點專門店"},
   "types":["dessert_shop"],"location":{"latitude":25.0477,"longitude":121.5169}},
  {"id":"tx-4","primaryType":"cafe","displayName":{"text":"純咖啡吧"},
   "types":["cafe","food"],"location":{"latitude":25.0476,"longitude":121.5168}},
  {"id":"tx-5","primaryType":"cafe","displayName":{"text":"供餐咖啡館"},
   "types":["cafe","restaurant"],"location":{"latitude":25.0475,"longitude":121.5167}},
  {"id":"tx-out","primaryType":"restaurant","displayName":{"text":"圈外餐廳"},
   "types":["restaurant"],"location":{"latitude":25.2000,"longitude":121.5170}}
]}`

// fake 端點：nearby 回 2 家一般餐廳；「拉麵」text 回 3 筆——
// tx-1 noodle_shop 麵框框（無 ramen type，應靠 query match 標上）、
// tx-2 與 nearby 重複的 place_id（驗 place_id 合併＋match 併入既有列）、
// tx-3 dessert_shop（tier1 衝突，match 應被拒）；
// 「甜點」text 固定 500（驗單支失敗容忍）。
func TestGoogleSearchNearbyCuisineFanOut(t *testing.T) {
	var nearbyCalls, ramenCalls, dessertCalls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		switch r.URL.Path {
		case "/v1/places:searchNearby":
			nearbyCalls.Add(1)
			_, _ = w.Write([]byte(gFanoutNearby))
		case "/v1/places:searchText":
			var body struct {
				TextQuery string `json:"textQuery"`
			}
			if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
				t.Errorf("decode text search body: %v", err)
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			switch body.TextQuery {
			case "拉麵":
				ramenCalls.Add(1)
				_, _ = w.Write([]byte(gFanoutRamen))
			case "甜點":
				dessertCalls.Add(1)
				w.WriteHeader(http.StatusInternalServerError)
			default:
				t.Errorf("unexpected textQuery %q", body.TextQuery)
				w.WriteHeader(http.StatusBadRequest)
			}
		default:
			t.Errorf("unexpected path %s", r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	defer srv.Close()

	p := NewGooglePlacesProvider("test-key", srv.URL)
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, []string{"ramen", "dessert"})
	if err != nil {
		t.Fatalf("單支 text search 失敗不應讓整體降級：%v", err)
	}
	if nearbyCalls.Load() != 1 || ramenCalls.Load() != 1 || dessertCalls.Load() != 2 {
		t.Errorf("fan-out calls nearby=%d ramen=%d dessert=%d，want 1/1/2", nearbyCalls.Load(), ramenCalls.Load(), dessertCalls.Load())
	}

	byID := make(map[string]Restaurant, len(result.Restaurants))
	counts := map[string]int{}
	for _, restaurant := range result.Restaurants {
		byID[restaurant.PlaceID] = restaurant
		counts[restaurant.PlaceID]++
	}
	if counts["tx-2"] != 1 || !slices.Equal(byID["tx-2"].QueryMatches, []string{"ramen"}) {
		t.Errorf("重複 place_id 應合併且保留 match，count=%d restaurant=%+v", counts["tx-2"], byID["tx-2"])
	}
	if got, ok := byID["tx-1"]; !ok || !slices.Equal(got.QueryMatches, []string{"ramen"}) || hasTag(got.CuisineTags, "ramen") {
		t.Errorf("tx-1 應只靠 query match 命中 ramen，got %+v", got)
	}
	if got, ok := byID["tx-3"]; !ok || len(got.QueryMatches) != 0 {
		t.Errorf("tier1 只拒 ramen match、不移除甜點店，got %+v", got)
	}
	if got, ok := byID["tx-4"]; !ok || len(got.QueryMatches) != 0 {
		t.Errorf("純 cafe 無供餐證據應拒熱食 match，got %+v", got)
	}
	if got := byID["tx-5"]; !slices.Equal(got.QueryMatches, []string{"ramen"}) {
		t.Errorf("cafe 有 restaurant 證據應收熱食 match，got %+v", got)
	}
	if _, ok := byID["tx-out"]; ok {
		t.Error("Text Search 圈外結果必須經 haversine 硬過濾")
	}
	if _, nearbyOK := byID["near-1"]; !nearbyOK {
		t.Error("單支失敗時 nearby 結果必須保留")
	}
}

func TestGoogleSearchNearbyFailureFailsWholeSearch(t *testing.T) {
	var nearbyCalls, textCalls atomic.Int32
	textStarted := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/places:searchNearby" {
			if nearbyCalls.Add(1) == 1 {
				select {
				case <-textStarted:
				case <-time.After(5 * time.Second):
					t.Error("text search 未並行啟動")
				}
			}
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		if textCalls.Add(1) == 1 {
			close(textStarted)
		}
		_, _ = io.Copy(io.Discard, r.Body)
		select {
		case <-r.Context().Done():
		case <-time.After(30 * time.Second):
			t.Error("text search 未收到 request context 取消")
		}
	}))
	defer srv.Close()

	p := NewGooglePlacesProvider("test-key", srv.URL)
	started := time.Now()
	if _, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, []string{"ramen"}); err == nil {
		t.Fatal("nearby 重試後仍失敗必須讓整體失敗")
	}
	if elapsed := time.Since(started); elapsed >= 5*time.Second {
		t.Fatalf("nearby 確定失敗後應取消 text fan-out，elapsed=%v", elapsed)
	}
	if nearbyCalls.Load() != 2 {
		t.Fatalf("nearby 應維持重試一次，calls=%d", nearbyCalls.Load())
	}
	if textCalls.Load() != 1 {
		t.Fatalf("取消後 text 不應重試，calls=%d", textCalls.Load())
	}
}

func TestGoogleSearchNearbyQueryMatchesAreSortedAcrossCuisines(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/places:searchNearby" {
			_, _ = w.Write([]byte(`{"places":[]}`))
			return
		}
		_, _ = w.Write([]byte(`{"places":[{"id":"tx-both","primaryType":"restaurant","displayName":{"text":"雙命中餐廳"},"types":["restaurant"],"location":{"latitude":25.0478,"longitude":121.5170}}]}`))
	}))
	defer srv.Close()

	p := NewGooglePlacesProvider("test-key", srv.URL)
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, []string{"ramen", "hotpot"})
	if err != nil || len(result.Restaurants) != 1 {
		t.Fatalf("雙查詢同 place_id 應合成一列，got %d err %v", len(result.Restaurants), err)
	}
	if !slices.Equal(result.Restaurants[0].QueryMatches, []string{"hotpot", "ramen"}) {
		t.Fatalf("QueryMatches 應聯集並固定排序，got %v", result.Restaurants[0].QueryMatches)
	}
}

func TestChainKey(t *testing.T) {
	for _, tc := range []struct {
		name string
		want string
	}{
		{"麥當勞-台北民生餐廳", "麥當勞"},
		{"丸龜製麵 台北車站店", "丸龜製麵"},
		{"一蘭 台北本店", "一蘭"},
		{"Mo-Mo-Paradise", "Mo-Mo-Paradise"},
		{"金峰滷肉飯", "金峰滷肉飯"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := chainKey(tc.name); got != tc.want {
				t.Fatalf("chainKey(%q) = %q，want %q", tc.name, got, tc.want)
			}
		})
	}
}

func TestGoogleSearchNearbyDedupesChainToNearestBranch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/places:searchNearby" {
			_, _ = w.Write([]byte(`{"places":[]}`))
			return
		}
		var body struct {
			TextQuery string `json:"textQuery"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Errorf("decode text search body: %v", err)
			w.WriteHeader(http.StatusBadRequest)
			return
		}
		if body.TextQuery == "拉麵" {
			_, _ = w.Write([]byte(`{"places":[{"id":"chain-far","primaryType":"noodle_shop","displayName":{"text":"丸龜製麵 台北車站店"},"types":["noodle_shop"],"location":{"latitude":25.0520,"longitude":121.5170}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"places":[{"id":"chain-near","primaryType":"noodle_shop","displayName":{"text":"丸龜製麵 信義店"},"types":["noodle_shop"],"location":{"latitude":25.0479,"longitude":121.5170}}]}`))
	}))
	defer srv.Close()

	p := NewGooglePlacesProvider("test-key", srv.URL)
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, []string{"ramen", "hotpot"})
	if err != nil || len(result.Restaurants) != 1 {
		t.Fatalf("同連鎖應只留一家，got %d err %v", len(result.Restaurants), err)
	}
	if got := result.Restaurants[0]; got.PlaceID != "chain-near" || !slices.Equal(got.QueryMatches, []string{"hotpot", "ramen"}) {
		t.Fatalf("應留最近分店並聯集 matches，got %+v", got)
	}
	if slices.Contains(result.RejectedPlaceIDs, "chain-far") {
		t.Fatalf("被連鎖去重分店不可進 RejectedPlaceIDs：%v", result.RejectedPlaceIDs)
	}
	if slices.Contains(result.DiscardedClosedPlaceIDs, "chain-far") {
		t.Fatalf("營業中的連鎖去重分店不可進 DiscardedClosedPlaceIDs：%v", result.DiscardedClosedPlaceIDs)
	}
}

func TestGoogleSearchNearbyTombstonesDiscardedClosedBranch(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/places:searchNearby" {
			_, _ = w.Write([]byte(`{"places":[{"id":"closed-near","businessStatus":"CLOSED_PERMANENTLY","primaryType":"restaurant","displayName":{"text":"一蘭 台北本店"},"types":["restaurant"],"location":{"latitude":25.0479,"longitude":121.5170}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"places":[{"id":"open-far","businessStatus":"OPERATIONAL","primaryType":"restaurant","displayName":{"text":"一蘭 信義店"},"types":["restaurant"],"location":{"latitude":25.0520,"longitude":121.5170}}]}`))
	}))
	defer srv.Close()

	p := NewGooglePlacesProvider("test-key", srv.URL)
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, []string{"ramen"})
	if err != nil || len(result.Restaurants) != 1 || result.Restaurants[0].PlaceID != "open-far" {
		t.Fatalf("歇業近店必須讓位給營業中分店，got %+v err %v", result.Restaurants, err)
	}
	if !slices.Contains(result.DiscardedClosedPlaceIDs, "closed-near") {
		t.Fatalf("落選歇業分店應供 handler tombstone：%v", result.DiscardedClosedPlaceIDs)
	}
	if slices.Contains(result.RejectedPlaceIDs, "closed-near") {
		t.Fatalf("落選歇業分店不可混入 RejectedPlaceIDs：%v", result.RejectedPlaceIDs)
	}
}

func TestGoogleSearchNearbyTombstonesClosedBranchDiscardedWithoutReplacement(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/places:searchNearby" {
			_, _ = w.Write([]byte(`{"places":[{"id":"open-far","businessStatus":"OPERATIONAL","primaryType":"restaurant","displayName":{"text":"一蘭 台北本店"},"types":["restaurant"],"location":{"latitude":25.0520,"longitude":121.5170}}]}`))
			return
		}
		_, _ = w.Write([]byte(`{"places":[{"id":"closed-near","businessStatus":"CLOSED_PERMANENTLY","primaryType":"restaurant","displayName":{"text":"一蘭 信義店"},"types":["restaurant"],"location":{"latitude":25.0479,"longitude":121.5170}}]}`))
	}))
	defer srv.Close()

	p := NewGooglePlacesProvider("test-key", srv.URL)
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000, []string{"ramen"})
	if err != nil || len(result.Restaurants) != 1 || result.Restaurants[0].PlaceID != "open-far" {
		t.Fatalf("營業中分店必須保留，got %+v err %v", result.Restaurants, err)
	}
	if !slices.Contains(result.DiscardedClosedPlaceIDs, "closed-near") {
		t.Fatalf("未取代留存者的落選歇業分店應供 handler tombstone：%v", result.DiscardedClosedPlaceIDs)
	}
}

func TestDedupeChainsFiltersTier1InheritedMatches(t *testing.T) {
	got, _ := dedupeChains([]Restaurant{
		{PlaceID: "dessert-near", Name: "連鎖品牌 台北店", PrimaryType: "dessert_shop", Lat: 25.0479, Lng: 121.5170},
		{PlaceID: "meal-far", Name: "連鎖品牌 信義店", PrimaryType: "restaurant", QueryMatches: []string{"ramen"}, Lat: 25.0520, Lng: 121.5170},
	}, 25.0478, 121.5170)
	if len(got) != 1 || got[0].PlaceID != "dessert-near" || slices.Contains(got[0].QueryMatches, "ramen") {
		t.Fatalf("甜品留存分店不可繼承姐妹店的熱食 match，got %+v", got)
	}
}

// 本輪（2026-08-16 普查）新增的對映逐條釘住。只釘新增的：既有對映已在線上跑過，
// 把整張表抄一遍是 DRY 違反，且未來每次正常擴充都要改兩個地方。
func TestNewGoogleTypeMappings(t *testing.T) {
	for _, tc := range []struct {
		gtype string
		want  []string
	}{
		{"taiwanese_restaurant", []string{"taiwanese"}},
		{"western_restaurant", []string{"western"}},
		{"european_restaurant", []string{"western"}},
		{"japanese_izakaya_restaurant", []string{"japanese"}},
		{"yakiniku_restaurant", []string{"japanese"}},
		{"japanese_curry_restaurant", []string{"japanese"}},
	} {
		got := gTags(gPlace{Types: []string{"restaurant", tc.gtype}})
		for _, want := range tc.want {
			if !hasTag(got, want) {
				t.Errorf("%s 應產出 %q，got %v", tc.gtype, want, got)
			}
		}
	}
}

// chinese_restaurant 涵蓋台菜、港式與其他中菜。2026-08-16 實測 259 家樣本中 165 家帶此
// type：15% 也有 taiwanese_restaurant（真台菜）、14% 也有 cantonese/dim_sum（港式，卻被
// 標成台式）、72% 兩者皆無而無從分辨。誤標實例：玖龍冰室香港茶餐廳、富宴精緻粵菜港式飲茶。
// 精確訊號 taiwanese_restaurant 已於同批變更對映，這條猜測不再需要。
func TestChineseRestaurantDoesNotImplyTaiwanese(t *testing.T) {
	p := gPlace{Types: []string{"restaurant", "chinese_restaurant"}}
	if hasTag(gTags(p), "taiwanese") {
		t.Errorf("chinese_restaurant 單獨產出 taiwanese；gTags = %v", gTags(p))
	}
}

// 反向：真台菜店的 canonical tag 必須留住。
func TestTaiwaneseRestaurantTypeGrantsTaiwanese(t *testing.T) {
	p := gPlace{Types: []string{"restaurant", "taiwanese_restaurant", "chinese_restaurant"}}
	if !hasTag(gTags(p), "taiwanese") {
		t.Errorf("taiwanese_restaurant 沒有產出 taiwanese；gTags = %v", gTags(p))
	}
}

// 港式店最常見的 type 組合不得再被標成台式。
func TestCantoneseRestaurantIsNotTaggedTaiwanese(t *testing.T) {
	p := gPlace{Types: []string{"restaurant", "chinese_restaurant", "cantonese_restaurant"}}
	tags := gTags(p)
	if hasTag(tags, "taiwanese") {
		t.Errorf("港式店被標成 taiwanese；gTags = %v", tags)
	}
	if !hasTag(tags, "cantonese") {
		t.Errorf("港式店少了 cantonese；gTags = %v", tags)
	}
}

// 降級模式的已接受代價（eng review T4）：只帶 chinese_restaurant 的真台菜，
// 在 provider 失敗走快取時沒有 canonical taiwanese、也沒有 query match（ADR-0006：
// query_matches 不進 restaurants 快取），cuisine_filter 開啟時會被硬排除。
// 主路徑靠「台式料理」定向檢索補回；本測試釘住降級側的行為，讓它是已知狀態不是意外。
func TestChineseOnlyRestaurantHasNoTaiwaneseSignalWithoutQueryMatch(t *testing.T) {
	r := gRestaurant(gPlace{Types: []string{"restaurant", "chinese_restaurant"}})
	if hasTag(r.CuisineTags, "taiwanese") {
		t.Errorf("chinese_restaurant 不應產出 canonical taiwanese：%v", r.CuisineTags)
	}
	if len(r.QueryMatches) != 0 {
		t.Errorf("未經 textSearch 的列不得帶 query match：%v", r.QueryMatches)
	}
}

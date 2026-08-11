package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
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

func TestGoogleMealPrimaryTypeExcludesDeliveryOnly(t *testing.T) {
	for _, primaryType := range []string{"meal_delivery", "pizza_delivery"} {
		if gIsMealPrimaryType(primaryType) {
			t.Errorf("%s 是純外送類型，不得進入前往用餐候選", primaryType)
		}
	}
	if !gIsMealPrimaryType("meal_takeaway") {
		t.Error("meal_takeaway 有可前往取餐的地點，仍應保留")
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
			ExcludedPrimaryTypes []string `json:"excludedPrimaryTypes"`
		}
		if err := json.NewDecoder(r.Body).Decode(&requestBody); err != nil {
			t.Errorf("decode request body: %v", err)
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
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000)
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
	if !hasTag(sushi.CuisineTags, "japanese") || !hasTag(sushi.CuisineTags, "sushi") {
		t.Errorf("types 應映到 japanese+sushi：%v", sushi.CuisineTags)
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
	result, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000)
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
	_, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000)
	if err == nil || !strings.Contains(err.Error(), "quota exceeded for this key") {
		t.Fatalf("non-200 error 應含 response body snippet，got %v", err)
	}
}

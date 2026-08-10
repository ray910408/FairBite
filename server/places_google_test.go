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
  {"id":"gp-1","displayName":{"text":"山本壽司"},
   "types":["sushi_restaurant","japanese_restaurant","restaurant"],
   "priceLevel":"PRICE_LEVEL_MODERATE",
   "location":{"latitude":25.0478,"longitude":121.5170},
   "formattedAddress":"台北市中正區某路1號","rating":4.3,
   "servesVegetarianFood":false,
   "regularOpeningHours":{"periods":[
     {"open":{"day":1,"hour":11,"minute":0},"close":{"day":1,"hour":22,"minute":30}}]}},
  {"id":"gp-2","displayName":{"text":"深夜食堂"},
   "types":["restaurant"],
   "location":{"latitude":25.0480,"longitude":121.5175},
   "formattedAddress":"台北市中正區某路2號","rating":4.0,
   "servesVegetarianFood":true,
   "regularOpeningHours":{"periods":[
     {"open":{"day":5,"hour":17,"minute":0},"close":{"day":6,"hour":2,"minute":0}}]}},
  {"id":"gp-3","displayName":{"text":"全日早餐"},
   "types":["breakfast_restaurant"],
   "priceLevel":"PRICE_LEVEL_INEXPENSIVE",
   "location":{"latitude":25.0470,"longitude":121.5160},
   "formattedAddress":"台北市中正區某路3號","rating":3.9,
   "regularOpeningHours":{"periods":[{"open":{"day":0,"hour":0,"minute":0}}]}},
  {"id":"gp-4","displayName":{"text":"週末長時段餐廳"},
   "types":["restaurant"],
   "priceLevel":"PRICE_LEVEL_INEXPENSIVE",
   "location":{"latitude":25.0472,"longitude":121.5162},
   "formattedAddress":"台北市中正區某路4號","rating":4.1,
   "regularOpeningHours":{"periods":[
     {"open":{"day":5,"hour":10,"minute":0},"close":{"day":6,"hour":12,"minute":0}}]}},
  {"id":"gp-5","displayName":{"text":"跨週末餐廳"},
   "types":["restaurant"],
   "priceLevel":"PRICE_LEVEL_INEXPENSIVE",
   "location":{"latitude":25.0474,"longitude":121.5164},
   "formattedAddress":"台北市中正區某路5號","rating":4.2,
   "regularOpeningHours":{"periods":[
     {"open":{"day":5,"hour":17,"minute":0},"close":{"day":0,"hour":2,"minute":0}}]}}
]}`

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
	rs, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000)
	if err != nil || len(rs) != 5 {
		t.Fatalf("want 5 restaurants, got %d err %v", len(rs), err)
	}
	byPID := map[string]Restaurant{}
	for _, r := range rs {
		byPID[r.PlaceID] = r
	}
	sushi := byPID["gp-1"]
	if sushi.Name != "山本壽司" || sushi.PriceLevel != 2 || sushi.Rating != 4.3 {
		t.Errorf("基本欄位對映錯誤：%+v", sushi)
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
}

func TestGoogleProviderRetries(t *testing.T) {
	srv := gServer(t, true)
	defer srv.Close()
	p := NewGooglePlacesProvider("test-key", srv.URL)
	rs, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 1000)
	if err != nil || len(rs) == 0 {
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

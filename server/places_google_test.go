package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"
)

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
   "regularOpeningHours":{"periods":[{"open":{"day":0,"hour":0,"minute":0}}]}}
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
	if err != nil || len(rs) != 3 {
		t.Fatalf("want 3 restaurants, got %d err %v", len(rs), err)
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
	if late.PriceLevel != 2 {
		t.Errorf("缺 priceLevel 應 fallback 中間值 2，got %d", late.PriceLevel)
	}
	if !late.Hours.IsOpenAt(at(time.Saturday, 1, 0)) || late.Hours.IsOpenAt(at(time.Saturday, 3, 0)) {
		t.Error("跨夜時段轉換錯誤")
	}
	breakfast := byPID["gp-3"]
	if !breakfast.Hours.IsOpenAt(at(time.Wednesday, 4, 0)) {
		t.Error("無 close 的單一 period 應視為 24/7")
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

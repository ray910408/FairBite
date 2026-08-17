package main

import (
	"context"
	"reflect"
	"testing"
	"time"
)

func at(weekday time.Weekday, hh, mm int) time.Time {
	// 2026-08-02 是週日；加 weekday 天得到該星期各日
	base := time.Date(2026, 8, 2, 0, 0, 0, 0, time.Local)
	return base.AddDate(0, 0, int(weekday)).Add(time.Duration(hh)*time.Hour + time.Duration(mm)*time.Minute)
}

func TestOpeningHours(t *testing.T) {
	oh := OpeningHours{"mon": {{660, 1350}}} // 週一 11:00–22:30
	if !oh.IsOpenAt(at(time.Monday, 12, 0)) {
		t.Error("週一中午應為營業中")
	}
	if oh.IsOpenAt(at(time.Monday, 23, 0)) {
		t.Error("週一 23:00 應為未營業")
	}
	if oh.IsOpenAt(at(time.Tuesday, 12, 0)) {
		t.Error("週二未定義應為未營業")
	}
	if got := oh.MinutesUntilClose(at(time.Monday, 22, 0)); got != 30 {
		t.Errorf("22:00 距打烊應為 30，got %d", got)
	}
}

func TestOpeningHoursOvernight(t *testing.T) {
	oh := OpeningHours{"fri": {{1020, 120}}} // 週五 17:00–翌日 02:00
	if !oh.IsOpenAt(at(time.Friday, 23, 0)) {
		t.Error("週五 23:00 應為營業中")
	}
	if !oh.IsOpenAt(at(time.Saturday, 1, 0)) {
		t.Error("週六 01:00（跨夜段）應為營業中")
	}
	if oh.IsOpenAt(at(time.Saturday, 3, 0)) {
		t.Error("週六 03:00 應為未營業")
	}
	if got := oh.MinutesUntilClose(at(time.Saturday, 1, 0)); got != 60 {
		t.Errorf("跨夜段 01:00 距打烊應為 60，got %d", got)
	}
	if got := oh.MinutesUntilClose(at(time.Friday, 23, 0)); got != 180 {
		t.Errorf("週五 23:00 距打烊應為 180（跨夜累計），got %d", got)
	}
}

func TestMinutesUntilCloseContinuesAcrossSplitDays(t *testing.T) {
	oh := OpeningHours{
		"fri": {{600, 1440}}, // 週五 10:00 起
		"sat": {{0, 720}},    // 週六 12:00 止
	}
	if got := oh.MinutesUntilClose(at(time.Friday, 23, 0)); got != 780 {
		t.Fatalf("週五 23:00 距週六 12:00 應為 780 分鐘，got %d", got)
	}
	if factor := closingFactor(Restaurant{Hours: oh}, EngineInput{Now: at(time.Friday, 23, 0)}); factor.Mult != 1.0 {
		t.Fatalf("跨午夜但仍營業 780 分鐘不應套 closing-soon，got %+v", factor)
	}
	if got := oh.MinutesUntilClose(at(time.Saturday, 11, 30)); got != 30 {
		t.Fatalf("週六 11:30 距打烊應為 30 分鐘，got %d", got)
	}
	if factor := closingFactor(Restaurant{Hours: oh}, EngineInput{Now: at(time.Saturday, 11, 30)}); factor.Mult != ClosingSoonMult {
		t.Fatalf("打烊前 30 分鐘應套 closing-soon，got %+v", factor)
	}
}

func TestMinutesUntilCloseFindsUnorderedMidnightContinuation(t *testing.T) {
	oh := OpeningHours{
		"fri": {{1020, 1440}},
		"sat": {{0, 1440}},
		"sun": {{600, 1200}, {0, 120}},
	}

	if got := oh.MinutesUntilClose(at(time.Saturday, 23, 30)); got != 150 {
		t.Fatalf("週六 23:30 距週日 02:00 應為 150 分鐘，got %d", got)
	}
	if !oh.IsOpenAt(at(time.Sunday, 1, 0)) {
		t.Error("週日 01:00 應為營業中")
	}
	if oh.IsOpenAt(at(time.Sunday, 3, 0)) {
		t.Error("週日 03:00 應為未營業")
	}
	if !oh.IsOpenAt(at(time.Sunday, 11, 0)) {
		t.Error("週日 11:00 應為營業中")
	}
	if got := oh.MinutesUntilClose(at(time.Sunday, 11, 0)); got != 540 {
		t.Fatalf("週日 11:00 距週日 20:00 應為 540 分鐘，got %d", got)
	}
}

func TestMinutesUntilCloseTwentyFourSevenIsNotClosingSoon(t *testing.T) {
	oh := daily([2]int{0, 1440})
	now := at(time.Monday, 12, 0)
	if got := oh.MinutesUntilClose(now); got < 7*1440 {
		t.Fatalf("24/7 應回傳足夠大的距打烊時間，got %d", got)
	}
	if factor := closingFactor(Restaurant{Hours: oh}, EngineInput{Now: now}); factor.Mult != 1.0 {
		t.Fatalf("24/7 不應套 closing-soon，got %+v", factor)
	}
}

func TestMockProviderRadius(t *testing.T) {
	p := NewMockProvider()
	all, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 2000, nil)
	if err != nil || len(all.Restaurants) < 10 {
		t.Fatalf("2km 內應有至少 10 家，got %d err %v", len(all.Restaurants), err)
	}
	for _, r := range all.Restaurants {
		if !gIsMealPrimaryType(r.PrimaryType) {
			t.Errorf("mock 餐廳 %s 缺少合格 primaryType：%q", r.PlaceID, r.PrimaryType)
		}
	}
	near, _ := p.SearchNearby(context.Background(), 25.0478, 121.5170, 300, nil)
	if len(near.Restaurants) == 0 || len(near.Restaurants) >= len(all.Restaurants) {
		t.Fatalf("300m 應為非空真子集，got %d / %d", len(near.Restaurants), len(all.Restaurants))
	}
	for _, r := range near.Restaurants {
		if Haversine(25.0478, 121.5170, r.Lat, r.Lng) > 300 {
			t.Errorf("%s 超出半徑", r.Name)
		}
	}
}

func TestMockProviderSynthesizesCuisineQueryMatches(t *testing.T) {
	result, err := NewMockProvider().SearchNearby(context.Background(), 25.0478, 121.5170, 3000, []string{"ramen", "indian"})
	if err != nil {
		t.Fatal(err)
	}
	byID := make(map[string]Restaurant, len(result.Restaurants))
	for _, restaurant := range result.Restaurants {
		byID[restaurant.PlaceID] = restaurant
	}
	for _, tc := range []struct {
		placeID string
		want    []string
	}{
		{"mock-002", []string{"ramen"}},
		{"mock-009", []string{"indian"}},
		{"mock-003", nil},
	} {
		got := byID[tc.placeID]
		if len(got.QueryMatches) != len(tc.want) {
			t.Errorf("%s QueryMatches = %v，want %v", tc.placeID, got.QueryMatches, tc.want)
			continue
		}
		for i := range tc.want {
			if got.QueryMatches[i] != tc.want[i] {
				t.Errorf("%s QueryMatches = %v，want %v", tc.placeID, got.QueryMatches, tc.want)
				break
			}
		}
	}
}

func TestCuisineUnionIsSortedAndDeduplicated(t *testing.T) {
	got := cuisineUnion([]Member{
		{Cuisines: []string{"ramen", "hotpot"}},
		{Cuisines: []string{"indian", "ramen"}},
	})
	want := []string{"hotpot", "indian", "ramen"}
	if len(got) != len(want) {
		t.Fatalf("cuisineUnion = %v，want %v", got, want)
	}
	for i := range want {
		if got[i] != want[i] {
			t.Fatalf("cuisineUnion = %v，want %v", got, want)
		}
	}
}

// 素食是嚴格禁忌（DietaryRequires）：沒有專屬檢索支線，素食店永遠進不了池——
// 2026-08-16 實測台北車站 1.5km 的 nearby 20 筆熱門中素食店為 0 家，
// 但 textSearch「素食」在同一個圈撈到 15 家、其中 13 家帶 vegetarian_restaurant type。
func TestCuisineUnionIncludesStrictDietaryAsSearchTerm(t *testing.T) {
	members := []Member{
		{UserID: "u1", Cuisines: []string{"japanese"}, Dietary: []string{"vegetarian"}},
		{UserID: "u2", Cuisines: []string{"hotpot"}},
	}
	got := cuisineUnion(members)
	want := []string{"hotpot", "japanese", "vegetarian"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("cuisineUnion = %v, want %v", got, want)
	}
}

// 負向禁忌不需要召回：no_beef/no_pork 是排除條件，多撈牛肉麵店對它們毫無幫助，
// 只會多花一次 Places 呼叫。只有 DietaryRequires 裡的嚴格禁忌才產生檢索詞。
func TestCuisineUnionExcludesNegativeDietary(t *testing.T) {
	members := []Member{
		{UserID: "u1", Cuisines: []string{"ramen"}, Dietary: []string{"no_beef", "no_pork"}},
	}
	got := cuisineUnion(members)
	want := []string{"ramen"}
	if !reflect.DeepEqual(got, want) {
		t.Errorf("cuisineUnion = %v, want %v", got, want)
	}
}

// 檢索支線要真的發得出去：fan-out 迴圈查不到查詢詞就 continue，會靜默失效。
func TestVegetarianHasSearchQuery(t *testing.T) {
	for key := range DietaryRequires {
		if _, ok := CuisineSearchQueries[key]; !ok {
			t.Errorf("嚴格禁忌 %q 沒有 Text Search 查詢詞——"+
				"定向檢索會對它靜默失效（SearchNearby fan-out 的 continue 分支）", key)
		}
	}
}

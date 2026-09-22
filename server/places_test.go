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
	day := OpeningHours{"mon": {{660, 1350}}}
	night := OpeningHours{"fri": {{1020, 120}}}
	unordered := OpeningHours{"fri": {{1020, 1440}}, "sat": {{0, 1440}}, "sun": {{600, 1200}, {0, 120}}}
	for _, tc := range []struct {
		name  string
		hours OpeningHours
		now   time.Time
		want  bool
	}{
		{"一般時段營業", day, at(time.Monday, 12, 0), true},
		{"一般時段打烊", day, at(time.Monday, 23, 0), false},
		{"未定義星期", day, at(time.Tuesday, 12, 0), false},
		{"跨夜當天", night, at(time.Friday, 23, 0), true},
		{"跨夜翌日", night, at(time.Saturday, 1, 0), true},
		{"跨夜打烊", night, at(time.Saturday, 3, 0), false},
		{"未排序午夜延續", unordered, at(time.Sunday, 1, 0), true},
		{"未排序時段間歇", unordered, at(time.Sunday, 3, 0), false},
		{"未排序白天時段", unordered, at(time.Sunday, 11, 0), true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.hours.IsOpenAt(tc.now); got != tc.want {
				t.Fatalf("IsOpenAt = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestMinutesUntilClose(t *testing.T) {
	split := OpeningHours{"fri": {{600, 1440}}, "sat": {{0, 720}}}
	unordered := OpeningHours{"fri": {{1020, 1440}}, "sat": {{0, 1440}}, "sun": {{600, 1200}, {0, 120}}}
	for _, tc := range []struct {
		name  string
		hours OpeningHours
		now   time.Time
		want  int
	}{
		{"一般打烊前", OpeningHours{"mon": {{660, 1350}}}, at(time.Monday, 22, 0), 30},
		{"跨夜翌日", OpeningHours{"fri": {{1020, 120}}}, at(time.Saturday, 1, 0), 60},
		{"跨夜當天累計", OpeningHours{"fri": {{1020, 120}}}, at(time.Friday, 23, 0), 180},
		{"拆分日期延續", split, at(time.Friday, 23, 0), 780},
		{"拆分日期即將打烊", split, at(time.Saturday, 11, 30), 30},
		{"未排序午夜延續", unordered, at(time.Saturday, 23, 30), 150},
		{"未排序白天時段", unordered, at(time.Sunday, 11, 0), 540},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := tc.hours.MinutesUntilClose(tc.now); got != tc.want {
				t.Fatalf("MinutesUntilClose = %d, want %d", got, tc.want)
			}
		})
	}
	t.Run("24/7 無近期打烊", func(t *testing.T) {
		if got := daily([2]int{0, 1440}).MinutesUntilClose(at(time.Monday, 12, 0)); got < 7*1440 {
			t.Fatalf("24/7 remaining minutes = %d", got)
		}
	})
}

func TestClosingFactorAcrossDays(t *testing.T) {
	split := OpeningHours{"fri": {{600, 1440}}, "sat": {{0, 720}}}
	for _, tc := range []struct {
		name  string
		hours OpeningHours
		now   time.Time
		want  float64
	}{
		{"午夜後仍營業", split, at(time.Friday, 23, 0), 1},
		{"隔天即將打烊", split, at(time.Saturday, 11, 30), ClosingSoonMult},
		{"24/7", daily([2]int{0, 1440}), at(time.Monday, 12, 0), 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := closingFactor(Restaurant{Hours: tc.hours}, EngineInput{Now: tc.now}); got.Mult != tc.want {
				t.Fatalf("closingFactor = %+v, want %v", got, tc.want)
			}
		})
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
		t.Run(tc.placeID, func(t *testing.T) {
			got := byID[tc.placeID]
			if len(got.QueryMatches) != len(tc.want) {
				t.Errorf("%s QueryMatches = %v，want %v", tc.placeID, got.QueryMatches, tc.want)
				return
			}
			for i := range tc.want {
				if got.QueryMatches[i] != tc.want[i] {
					t.Errorf("%s QueryMatches = %v，want %v", tc.placeID, got.QueryMatches, tc.want)
					break
				}
			}
		})
	}
}

func TestCuisineUnion(t *testing.T) {
	for _, tc := range []struct {
		name    string
		members []Member
		want    []string
	}{
		{"排序去重", []Member{{Cuisines: []string{"ramen", "hotpot"}}, {Cuisines: []string{"indian", "ramen"}}}, []string{"hotpot", "indian", "ramen"}},
		{"嚴格禁忌加入檢索詞", []Member{{UserID: "u1", Cuisines: []string{"japanese"}, Dietary: []string{"vegetarian"}}, {UserID: "u2", Cuisines: []string{"hotpot"}}}, []string{"hotpot", "japanese", "vegetarian"}},
		{"忽略不支援的舊禁忌", []Member{{UserID: "u1", Cuisines: []string{"ramen"}, Dietary: []string{"no_beef", "no_pork"}}}, []string{"ramen"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := cuisineUnion(tc.members); !reflect.DeepEqual(got, tc.want) {
				t.Fatalf("cuisineUnion = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestStrictDietaryTerms(t *testing.T) {
	for _, tc := range []struct {
		name string
		in   []string
		want []string
	}{
		{"空輸入", nil, nil},
		{"無嚴格禁忌", []string{"hotpot", "japanese"}, nil},
		{"忽略舊 unsupported 值", []string{"no_beef", "no_pork"}, nil},
		{"混合舊值只保留 vegetarian", []string{"no_beef", "no_pork", "vegetarian"}, []string{"vegetarian"}},
		{"只有嚴格禁忌", []string{"vegetarian"}, []string{"vegetarian"}},
		{"混合輸入維持排序", []string{"hotpot", "japanese", "vegetarian"}, []string{"vegetarian"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := strictDietaryTerms(tc.in)
			if !reflect.DeepEqual(got, tc.want) {
				t.Errorf("strictDietaryTerms(%v) = %v, want %v", tc.in, got, tc.want)
			}
		})
	}
}

// 漂移閘門的方向性：只有「reload 後才要求、fetch 沒涵蓋」算 under-fetch。
// 取消嚴格禁忌回 409 會白丟一次已付費的搜尋（PR #18 codex review）。
func TestStrictDietaryUnderFetched(t *testing.T) {
	for _, tc := range []struct {
		name              string
		reloaded, fetched []string
		want              bool
	}{
		{"完全相同", []string{"ramen", "vegetarian"}, []string{"ramen", "vegetarian"}, false},
		{"新增嚴格禁忌＝under-fetch", []string{"ramen", "vegetarian"}, []string{"ramen"}, true},
		{"取消嚴格禁忌＝安全的超集", []string{"ramen"}, []string{"ramen", "vegetarian"}, false},
		{"只有菜系變動不算", []string{"korean"}, []string{"ramen"}, false},
		{"從零到有", []string{"vegetarian"}, nil, true},
		{"從有到零", nil, []string{"vegetarian"}, false},
		{"新增舊值不算 under-fetch", []string{"no_beef", "no_pork"}, nil, false},
		{"舊值混素食仍依素食判定", []string{"no_beef", "vegetarian"}, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := strictDietaryUnderFetched(tc.reloaded, tc.fetched); got != tc.want {
				t.Errorf("strictDietaryUnderFetched(%v, %v) = %v, want %v",
					tc.reloaded, tc.fetched, got, tc.want)
			}
		})
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

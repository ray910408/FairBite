package main

import (
	"strings"
	"testing"
	"time"
)

var lunchMonday = at(time.Monday, 12, 0) // 沿用 places_test.go 的 at()

func member(over func(*Member)) Member {
	m := Member{UserID: "u1", DisplayName: "小明", BudgetMax: 500,
		Cuisines: []string{"japanese"}, MaxDistanceM: 2000, Transport: "walking"}
	if over != nil {
		over(&m)
	}
	return m
}

func hasKind(ks []string, want string) bool {
	for _, k := range ks {
		if k == want {
			return true
		}
	}
	return false
}

func rest(over func(*Restaurant)) Restaurant {
	r := Restaurant{PlaceID: "p1", Name: "測試餐廳", CuisineTags: []string{"japanese"},
		PriceLevel: 1, Lat: 25.0480, Lng: 121.5172, Hours: daily([2]int{0, 1440})}
	if over != nil {
		over(&r)
	}
	return r
}

func TestHardFilters(t *testing.T) {
	cases := []struct {
		name       string
		r          Restaurant
		ms         []Member
		wantKind   string // "" = 應保留
		wantReason string
	}{
		{"全部通過", rest(nil), []Member{member(nil)}, "", ""},
		{"素食成員排除火鍋", rest(func(r *Restaurant) { r.CuisineTags = []string{"hotpot"} }),
			[]Member{member(func(m *Member) { m.Dietary = []string{"vegetarian"} })},
			"dietary", "vegetarian"},
		{"價位超過最低預算", rest(func(r *Restaurant) { r.PriceLevel = 4 }),
			[]Member{member(nil), member(func(m *Member) { m.UserID = "u2"; m.BudgetMax = 200 })},
			"budget", "NT$"},
		{"未營業", rest(func(r *Restaurant) { r.Hours = daily([2]int{330, 660}) }),
			[]Member{member(nil)}, "closed", "未營業"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := Evaluate(EngineInput{Restaurants: []Restaurant{c.r}, Members: c.ms,
				Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170})
			if c.wantKind == "" {
				if len(res.Kept) != 1 {
					t.Fatalf("應保留，got excluded %+v", res.Excluded)
				}
				return
			}
			if len(res.Excluded) != 1 {
				t.Fatalf("應排除，got kept %+v", res.Kept)
			}
			e := res.Excluded[0]
			if !hasKind(e.Kinds, c.wantKind) || !strings.Contains(e.Reason, c.wantReason) {
				t.Errorf("want kind=%s reason 含 %q，got %v %q", c.wantKind, c.wantReason, e.Kinds, e.Reason)
			}
		})
	}
}

func TestHardFilterCollectsAllReasons(t *testing.T) {
	r := rest(func(r *Restaurant) {
		r.CuisineTags = []string{"steak"}
		r.PriceLevel = 4
		r.Hours = daily([2]int{330, 660}) // 午餐時間未營業
	})
	ms := []Member{member(func(m *Member) { m.Dietary = []string{"no_beef"}; m.BudgetMax = 200 })}
	res := Evaluate(EngineInput{Restaurants: []Restaurant{r}, Members: ms,
		Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170})
	e := res.Excluded[0]
	if len(e.Kinds) != 3 {
		t.Fatalf("應收集全部 3 種排除類別，got %v", e.Kinds)
	}
	if !strings.Contains(e.Reason, "；") || !strings.Contains(e.Reason, "小明") {
		t.Errorf("多重原因應以；串接且含成員名，got %q", e.Reason)
	}
}

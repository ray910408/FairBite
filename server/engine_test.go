package main

import (
	"fmt"
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

func TestUnknownPriceDoesNotBudgetExclude(t *testing.T) {
	unknown := rest(func(r *Restaurant) {
		r.PlaceID = "unknown-price"
		r.PriceLevel = PriceLevelUnknown
	})
	expensive := rest(func(r *Restaurant) {
		r.PlaceID = "expensive-control"
		r.PriceLevel = 4
	})
	res := Evaluate(EngineInput{
		Restaurants: []Restaurant{unknown, expensive},
		Members: []Member{member(func(m *Member) {
			m.BudgetMax = 100
		})},
		Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
	})
	if len(res.Kept) != 1 || res.Kept[0].PlaceID != unknown.PlaceID {
		t.Fatalf("未知價位應保留，got kept=%+v excluded=%+v", res.Kept, res.Excluded)
	}
	for _, entry := range res.Kept[0].Trace {
		if strings.Contains(entry.Reason, "預算") || strings.Contains(entry.Reason, "NT$") {
			t.Errorf("未知價位 trace 不應包含預算理由：%+v", entry)
		}
	}
	if len(res.Excluded) != 1 || res.Excluded[0].PlaceID != expensive.PlaceID ||
		!hasKind(res.Excluded[0].Kinds, "budget") {
		t.Fatalf("price level 4 控制組應因預算排除，got %+v", res.Excluded)
	}
}

func TestScoringFactors(t *testing.T) {
	rJP := rest(func(r *Restaurant) { r.PlaceID = "jp"; r.CuisineTags = []string{"japanese"} })
	rKR := rest(func(r *Restaurant) { r.PlaceID = "kr"; r.CuisineTags = []string{"korean"} })
	ms := []Member{
		member(nil), // 偏好 japanese
		member(func(m *Member) { m.UserID = "u2"; m.Cuisines = []string{"japanese", "korean"} }),
	}
	res := Evaluate(EngineInput{Restaurants: []Restaurant{rJP, rKR}, Members: ms,
		Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170})
	if len(res.Kept) != 2 {
		t.Fatalf("應保留 2 家，got %d", len(res.Kept))
	}
	byID := map[string]Candidate{}
	for _, c := range res.Kept {
		byID[c.PlaceID] = c
	}
	if !(byID["jp"].Score > byID["kr"].Score) {
		t.Errorf("2/2 命中的日式應高於 1/2 命中的韓式：%f vs %f", byID["jp"].Score, byID["kr"].Score)
	}
	var sum float64
	for _, c := range res.Kept {
		sum += c.Probability
		if len(c.Trace) != 5 {
			t.Errorf("%s trace 應有 5 個因素，got %d", c.PlaceID, len(c.Trace))
		}
		for _, e := range c.Trace {
			if e.Reason == "" || e.Mult <= 0 {
				t.Errorf("trace 不完整: %+v", e)
			}
		}
	}
	if sum < 0.9999 || sum > 1.0001 {
		t.Errorf("機率總和應為 1，got %f", sum)
	}
}

func TestDistFactorClamp(t *testing.T) {
	in := EngineInput{Members: []Member{member(nil)},
		CenterLat: 25.0478, CenterLng: 121.5170}
	near := rest(func(r *Restaurant) { r.Lat = 25.0478; r.Lng = 121.5170 }) // 0m → ≤5min
	if e := distFactor(near, in); e.Mult != DistMultBest {
		t.Errorf("近距離應夾至 %v，got %v", DistMultBest, e.Mult)
	}
	far := rest(func(r *Restaurant) { r.Lat = 25.0478; r.Lng = 121.5430 }) // ~2.6km 步行 ~35min → ≥25min
	if e := distFactor(far, in); e.Mult != DistMultWorst {
		t.Errorf("遠距離應夾至 %v，got %v", DistMultWorst, e.Mult)
	}
}

func TestDistOverheadAndSlowest(t *testing.T) {
	// 兩位成員：步行 vs 大眾運輸。距離 ~1500m：
	// 步行 0 + 1500/75 = 20 分；大眾運輸 8 + 1500/200 = 15.5 分 → 最慢是步行
	in := EngineInput{
		Members: []Member{
			member(nil), // walking
			member(func(m *Member) { m.UserID = "u2"; m.Transport = "transit" }),
		},
		CenterLat: 25.0478, CenterLng: 121.5170,
	}
	r := rest(func(r *Restaurant) { r.Lat = 25.0478; r.Lng = 121.5319 }) // 東移 ~1500m
	e := distFactor(r, in)
	if !strings.Contains(e.Reason, "最慢") || !strings.Contains(e.Reason, "步行") {
		t.Errorf("reason 應標示最慢成員與交通方式：%q", e.Reason)
	}
	// transit 的 overhead 生效：純除法是 7.5 分，加 8 分 overhead 後 >15 分
	solo := EngineInput{
		Members:   []Member{member(func(m *Member) { m.Transport = "transit" })},
		CenterLat: 25.0478, CenterLng: 121.5170,
	}
	e2 := distFactor(r, solo)
	if !strings.Contains(e2.Reason, "16 分鐘") && !strings.Contains(e2.Reason, "15 分鐘") {
		t.Errorf("transit overhead 應計入估時：%q", e2.Reason)
	}
}

func TestClosingSoonDemoted(t *testing.T) {
	soon := rest(func(r *Restaurant) { r.PlaceID = "soon"; r.Hours = daily([2]int{0, 750}) }) // 12:30 打烊
	late := rest(func(r *Restaurant) { r.PlaceID = "late"; r.Hours = daily([2]int{0, 1440}) })
	res := Evaluate(EngineInput{Restaurants: []Restaurant{soon, late},
		Members: []Member{member(nil)}, Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170})
	byID := map[string]Candidate{}
	for _, c := range res.Kept {
		byID[c.PlaceID] = c
	}
	want := byID["late"].Score * ClosingSoonMult
	got := byID["soon"].Score
	if got < want-0.0001 || got > want+0.0001 {
		t.Errorf("即將打烊應 ×%.1f：got %f want %f", ClosingSoonMult, got, want)
	}
}

func TestVoteFactor(t *testing.T) {
	rA := rest(func(r *Restaurant) { r.PlaceID = "a" })
	rB := rest(func(r *Restaurant) { r.PlaceID = "b" })
	res := Evaluate(EngineInput{
		Restaurants: []Restaurant{rA, rB},
		Members:     []Member{member(nil)},
		Now:         lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
		Votes: map[string]VoteInfo{"a": {Ups: 2}},
	})
	byID := map[string]Candidate{}
	for _, c := range res.Kept {
		byID[c.PlaceID] = c
	}
	// 每張贊成票 +10%（spec §5）：兩票 → ×1.2
	want := byID["b"].Score * (1 + 2*VoteBoostPerUp)
	got := byID["a"].Score
	if got < want-0.0001 || got > want+0.0001 {
		t.Errorf("2 張贊成票應 ×%.1f：got %f want %f", 1+2*VoteBoostPerUp, got, want)
	}
	for _, c := range res.Kept {
		if len(c.Trace) != 5 {
			t.Errorf("%s trace 應有 5 個因素，got %d", c.PlaceID, len(c.Trace))
		}
	}
}

func TestVetoExcludes(t *testing.T) {
	rA := rest(func(r *Restaurant) { r.PlaceID = "a" })
	rB := rest(func(r *Restaurant) { r.PlaceID = "b" })
	res := Evaluate(EngineInput{
		Restaurants: []Restaurant{rA, rB},
		Members:     []Member{member(nil)},
		Now:         lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
		Votes: map[string]VoteInfo{"a": {Vetoers: []string{"小明", "小華"}}},
	})
	if len(res.Kept) != 1 || res.Kept[0].PlaceID != "b" {
		t.Fatalf("被否決者應移出轉盤，kept=%+v", res.Kept)
	}
	e := res.Excluded[0]
	if !hasKind(e.Kinds, "veto") {
		t.Errorf("kind 應含 veto，got %v", e.Kinds)
	}
	if e.Reason != "遭 小明、小華 否決（可收回）" {
		t.Errorf("reason 格式不符：%q", e.Reason)
	}
	// 唯一候選機率應為 1
	if p := res.Kept[0].Probability; p < 0.9999 || p > 1.0001 {
		t.Errorf("唯一候選機率應為 1，got %f", p)
	}
}

func TestNilVotesNeutral(t *testing.T) {
	res := Evaluate(EngineInput{Restaurants: []Restaurant{rest(nil)},
		Members: []Member{member(nil)}, Now: lunchMonday,
		CenterLat: 25.0478, CenterLng: 121.5170})
	if len(res.Kept) != 1 {
		t.Fatalf("nil Votes 不應影響保留，got %+v", res.Excluded)
	}
}

func recencyIn(rc RecencyCount, exploration string, nMembers int) EngineInput {
	ms := make([]Member, nMembers)
	for i := range ms {
		ms[i] = member(func(m *Member) { m.UserID = fmt.Sprintf("u%d", i) })
	}
	return EngineInput{Restaurants: []Restaurant{rest(nil)}, Members: ms,
		Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
		Recency:     map[string]RecencyCount{"p1": rc},
		Exploration: exploration}
}

func recencyMult(t *testing.T, in EngineInput) float64 {
	t.Helper()
	res := Evaluate(in)
	if len(res.Kept) != 1 {
		t.Fatalf("應保留，got %+v", res.Excluded)
	}
	for _, e := range res.Kept[0].Trace {
		if e.Factor == "recency" {
			return e.Mult
		}
	}
	t.Fatal("trace 缺 recency 因素")
	return 0
}

func TestRecencyFactor(t *testing.T) {
	// spec §5：全員 14 天內 → ×0.3；比例線性；15–30 天減半計
	cases := []struct {
		name string
		rc   RecencyCount
		expl string
		n    int
		want float64
	}{
		{"全員 14 天內", RecencyCount{Fresh: 4}, "balanced", 4, 0.3},
		{"半數 14 天內（線性內插）", RecencyCount{Fresh: 2}, "balanced", 4, 0.65},
		{"15-30 天減半計", RecencyCount{Fading: 4}, "balanced", 4, 0.65},
		{"無紀錄中性", RecencyCount{}, "balanced", 4, 1.0},
		{"熟悉檔懲罰減半", RecencyCount{Fresh: 4}, "familiar", 4, 0.65},
		{"探索檔加重", RecencyCount{Fresh: 4}, "explore", 4, 0.125},
		{"空字串視為 balanced", RecencyCount{Fresh: 4}, "", 4, 0.3},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := recencyMult(t, recencyIn(c.rc, c.expl, c.n))
			if got < c.want-0.0001 || got > c.want+0.0001 {
				t.Errorf("want %f got %f", c.want, got)
			}
		})
	}
}

func TestRecencyReason(t *testing.T) {
	res := Evaluate(recencyIn(RecencyCount{Fresh: 1, Fading: 2}, "balanced", 4))
	for _, e := range res.Kept[0].Trace {
		if e.Factor == "recency" {
			if e.Reason != "1 位成員 14 天內造訪過；2 位成員 15–30 天前造訪過" {
				t.Errorf("reason 格式不符：%q", e.Reason)
			}
			return
		}
	}
	t.Fatal("trace 缺 recency")
}

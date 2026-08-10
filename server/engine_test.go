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

func TestUnknownHoursNeverExcludeOrApplyClosingFactor(t *testing.T) {
	unknown := rest(func(r *Restaurant) {
		r.PlaceID = "unknown-hours"
		r.Hours = OpeningHours{}
	})
	closed := rest(func(r *Restaurant) {
		r.PlaceID = "closed-control"
		r.Hours = daily([2]int{330, 660})
	})
	for day := time.Sunday; day <= time.Saturday; day++ {
		for _, clock := range [][2]int{{0, 0}, {12, 0}, {23, 59}} {
			now := at(day, clock[0], clock[1])
			t.Run(fmt.Sprintf("%s-%02d:%02d", day, clock[0], clock[1]), func(t *testing.T) {
				res := Evaluate(EngineInput{
					Restaurants: []Restaurant{unknown, closed},
					Members:     []Member{member(nil)},
					Now:         now, CenterLat: 25.0478, CenterLng: 121.5170,
				})
				if len(res.Kept) != 1 || res.Kept[0].PlaceID != unknown.PlaceID {
					t.Fatalf("未知營業時間應保留，got kept=%+v excluded=%+v", res.Kept, res.Excluded)
				}
				for _, entry := range res.Kept[0].Trace {
					if entry.Factor == "closing_soon" || strings.Contains(entry.Reason, "打烊") {
						t.Errorf("未知營業時間不應有 closing-soon factor：%+v", entry)
					}
				}
				if len(res.Excluded) != 1 || res.Excluded[0].PlaceID != closed.PlaceID ||
					!hasKind(res.Excluded[0].Kinds, "closed") ||
					!strings.Contains(res.Excluded[0].Reason, "目前未營業") {
					t.Fatalf("已知未營業控制組應排除，got %+v", res.Excluded)
				}
			})
		}
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
		{"explore 的 recency 與 balanced 等價（探索語意改由 exposure 因素承擔）", RecencyCount{Fresh: 4}, "explore", 4, 0.3},
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

// 場上固定放一家「舊店」（Recommended>0）：新店加成只在混合場景有相對意義，
// 全場皆新時會被正規化抵銷、應為中性（D21）——單獨測 p1 時需要這個對照組。
func exposureIn(c ExposureCount, exploration string) EngineInput {
	old := rest(func(r *Restaurant) { r.PlaceID = "p-old" })
	return EngineInput{Restaurants: []Restaurant{rest(nil), old}, Members: []Member{member(nil)},
		Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
		Exposure:    map[string]ExposureCount{"p1": c, "p-old": {Recommended: 3}},
		Exploration: exploration}
}

func exposureMult(t *testing.T, in EngineInput) (float64, bool) {
	t.Helper()
	res := Evaluate(in)
	if len(res.Kept) == 0 {
		t.Fatalf("應保留，got %+v", res.Excluded)
	}
	for _, e := range res.Kept[0].Trace { // Kept[0] = p1（輸入順序）
		if e.Factor == "exposure" {
			return e.Mult, true
		}
	}
	return 1.0, false
}

func TestExposureFactor(t *testing.T) {
	cases := []struct {
		name        string
		c           ExposureCount
		exploration string
		want        float64
		wantTrace   bool
	}{
		{"新店_balanced", ExposureCount{}, "balanced", 1.1, true},
		{"新店_explore加倍", ExposureCount{}, "explore", 1.2, true},
		{"新店_familiar關閉", ExposureCount{}, "familiar", 1.0, false},
		{"推薦過未中選_中性", ExposureCount{Recommended: 3}, "balanced", 1.0, true},
		{"熟店_內插", ExposureCount{Recommended: 9, Chosen: 2}, "balanced", 0.96, true}, // 單人房：2/(5*1)=0.4
		{"熟店_達門檻", ExposureCount{Recommended: 9, Chosen: 5}, "balanced", 0.9, true},
		{"熟店_explore加重", ExposureCount{Recommended: 9, Chosen: 5}, "explore", 0.85, true},
		{"熟店_familiar關閉", ExposureCount{Recommended: 9, Chosen: 5}, "familiar", 1.0, false},
		{"未知檔位當balanced", ExposureCount{}, "", 1.1, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, hasTrace := exposureMult(t, exposureIn(c.c, c.exploration))
			if hasTrace != c.wantTrace {
				t.Fatalf("trace presence = %v, want %v", hasTrace, c.wantTrace)
			}
			if diff := got - c.want; diff > 1e-9 || diff < -1e-9 {
				t.Errorf("mult = %v, want %v", got, c.want)
			}
		})
	}
}

func TestNilExposureNeutral(t *testing.T) {
	in := exposureIn(ExposureCount{}, "balanced")
	in.Exposure = nil
	if _, hasTrace := exposureMult(t, in); hasTrace {
		t.Fatal("Exposure nil 不應產生 exposure trace")
	}
}

// D21/OV#7：全場皆新（區域首搜）時一致加成會被正規化抵銷 → 必須中性、不出虛構 chip
func TestAllNewCandidatesNeutral(t *testing.T) {
	in := exposureIn(ExposureCount{}, "balanced")
	in.Exposure["p-old"] = ExposureCount{} // 對照組也歸零 → 全場皆新
	if _, hasTrace := exposureMult(t, in); hasTrace {
		t.Fatal("全場皆新不應產生 exposure trace（加成會被 normalize 抵銷）")
	}
}

func TestExposureAllNewSurvivorsNeutralWhenOldCandidateExcluded(t *testing.T) {
	in := exposureIn(ExposureCount{}, "balanced")
	in.Restaurants[1].PriceLevel = 4 // p-old 超過成員預算，會在 factor pipeline 前被排除
	if _, hasTrace := exposureMult(t, in); hasTrace {
		t.Fatal("所有存活候選皆新時不應讓已排除舊店觸發 exposure trace")
	}
}

func TestExposureBaselineTreatsOwnSearchAsNew(t *testing.T) {
	in := exposureIn(ExposureCount{Recommended: 2}, "balanced")
	in.Members = append(in.Members, member(func(m *Member) { m.UserID = "u2" }))
	in.ExposureBaseline = map[string]int{"p1": len(in.Members)}
	got, hasTrace := exposureMult(t, in)
	if !hasTrace || got != 1.1 {
		t.Fatalf("Recommended 等於本房 baseline 應視為新店：got %v trace=%v", got, hasTrace)
	}
}

func TestExposureBaselineDoesNotSubtractCandidateExcludedAtSearch(t *testing.T) {
	in := exposureIn(ExposureCount{Recommended: 2}, "balanced")
	in.Members = append(in.Members, member(func(m *Member) { m.UserID = "u2" }))
	// p1 搜尋時遭排除，沒有收到本房曝光 +1，因此不在 baseline map。
	in.ExposureBaseline = map[string]int{"p-old": len(in.Members)}

	entry := exposureFactor(in.Restaurants[0], in)
	if entry.Mult != 1.0 || strings.Contains(entry.Reason, "新出現") {
		t.Fatalf("搜尋時被排除的候選不可扣 baseline 或取得新店加成：got %+v", entry)
	}
}

// 五人房吃過一次 ≠ 吃滿懲罰（D21/OV#5：人均門檻）
func TestChosenPenaltyIsPerCapita(t *testing.T) {
	in := exposureIn(ExposureCount{Recommended: 9, Chosen: 1}, "balanced")
	for i := 2; i <= 5; i++ {
		in.Members = append(in.Members, member(func(m *Member) { m.UserID = fmt.Sprintf("u%d", i) }))
	}
	got, hasTrace := exposureMult(t, in)
	want := 1 - 0.1*(1.0/25.0) // 1/(5*5) = 0.04 → 0.996
	if !hasTrace || got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("五人房 Chosen=1 應僅極輕降權：got %v want %v", got, want)
	}
	if entry := exposureFactor(in.Restaurants[0], in); entry.Reason != "房內累計中選 1 人次，稍作降權" {
		t.Fatalf("中選 trace 應使用人次：got %q", entry.Reason)
	}
}

func rainIn(w *Weather, transport string, lat float64) EngineInput {
	return EngineInput{
		Restaurants: []Restaurant{rest(func(r *Restaurant) { r.Lat = lat })},
		Members:     []Member{member(func(m *Member) { m.Transport = transport })},
		Now:         lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
		Weather: w,
	}
}

func weatherMult(t *testing.T, in EngineInput) (float64, bool) {
	t.Helper()
	res := Evaluate(in)
	if len(res.Kept) != 1 {
		t.Fatalf("應保留，got %+v", res.Excluded)
	}
	for _, e := range res.Kept[0].Trace {
		if e.Factor == "weather" {
			return e.Mult, true
		}
	}
	return 1.0, false
}

func TestRainFactor(t *testing.T) {
	rain := &Weather{RainMM: 2.0}
	cases := []struct {
		name      string
		in        EngineInput
		want      float64
		wantTrace bool
	}{
		{"無資料中性", rainIn(nil, "walking", 25.0586), 1.0, false},
		{"沒下雨中性", rainIn(&Weather{RainMM: 0}, "walking", 25.0586), 1.0, false},
		{"雨天步行遠_降權", rainIn(rain, "walking", 25.0586), 0.78, true},
		{"雨天開車_中性無trace", rainIn(rain, "driving", 25.0586), 1.0, false},
		{"雨天步行近_中性有trace", rainIn(rain, "walking", 25.0480), 1.0, true},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got, hasTrace := weatherMult(t, c.in)
			if hasTrace != c.wantTrace {
				t.Fatalf("trace presence = %v, want %v", hasTrace, c.wantTrace)
			}
			if diff := got - c.want; diff > 0.01 || diff < -0.01 {
				t.Errorf("mult = %v, want %v", got, c.want)
			}
		})
	}

	t.Run("混合交通取平均", func(t *testing.T) {
		rain := &Weather{RainMM: 2.0}
		in := rainIn(rain, "walking", 25.0586)
		in.Members = append(in.Members, member(func(m *Member) { m.UserID = "u2"; m.Transport = "driving" }))
		got, hasTrace := weatherMult(t, in)
		if !hasTrace || got < 0.88 || got > 0.90 { // (0.78 + 1.0) / 2 ≈ 0.89
			t.Fatalf("got %v trace=%v, want ≈0.89", got, hasTrace)
		}
	})
}

func TestTimeSlotFactor(t *testing.T) {
	slotMult := func(now time.Time, tags []string) (float64, bool) {
		res := Evaluate(EngineInput{
			Restaurants: []Restaurant{rest(func(r *Restaurant) { r.CuisineTags = tags })},
			Members:     []Member{member(nil)},
			Now:         now, CenterLat: 25.0478, CenterLng: 121.5170})
		if len(res.Kept) != 1 {
			t.Fatalf("應保留，got %+v", res.Excluded)
		}
		for _, e := range res.Kept[0].Trace {
			if e.Factor == "timeslot" {
				return e.Mult, true
			}
		}
		return 1.0, false
	}
	morning := at(time.Monday, 8, 0)
	if m, ok := slotMult(morning, []string{"breakfast", "taiwanese"}); !ok || m != TimeSlotBoostMult {
		t.Errorf("早餐時段 breakfast 應加成，got %v %v", m, ok)
	}
	if _, ok := slotMult(lunchMonday, []string{"breakfast"}); ok {
		t.Error("午餐時段不在任何 slot，不應有 timeslot trace")
	}
	if _, ok := slotMult(morning, []string{"japanese"}); ok {
		t.Error("早餐時段未命中 tag 不應有 trace")
	}
	// D23：晚餐 slot 不存在（hotpot 無真實 tag 來源），晚上不得有任何 timeslot trace
	if _, ok := slotMult(at(time.Monday, 19, 0), []string{"hotpot"}); ok {
		t.Error("晚餐時段已移除，不應有 trace")
	}
	// 時段邊界（2026-08-10 eng review Test Review）
	for _, c := range []struct {
		name string
		now  time.Time
		tags []string
		want bool
	}{
		{"05:59 不在早餐時段", at(time.Monday, 5, 59), []string{"breakfast"}, false},
		{"06:00 起算", at(time.Monday, 6, 0), []string{"breakfast"}, true},
		{"10:59 仍算", at(time.Monday, 10, 59), []string{"breakfast"}, true},
		{"11:00 結束", at(time.Monday, 11, 0), []string{"breakfast"}, false},
	} {
		if _, ok := slotMult(c.now, c.tags); ok != c.want {
			t.Errorf("%s: trace presence = %v, want %v", c.name, ok, c.want)
		}
	}
}

func TestSatisfactionEMA(t *testing.T) {
	if got := satisfactionEMA([]float64{1}); got != 1 {
		t.Fatalf("單樣本即初值，got %v", got)
	}
	// 由舊到新折入：初值 1.0，新樣本 0.0 → 0.3*0 + 0.7*1 = 0.7
	if got := satisfactionEMA([]float64{1, 0}); got < 0.699 || got > 0.701 {
		t.Fatalf("got %v, want 0.7", got)
	}
}

func TestPrefFairnessBoost(t *testing.T) {
	in := EngineInput{
		Restaurants: []Restaurant{rest(nil)}, // japanese
		Members: []Member{
			member(nil), // u1 小明 japanese
			member(func(m *Member) { m.UserID = "u2"; m.DisplayName = "小華"; m.Cuisines = []string{"taiwanese"} }),
		},
		Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
	}
	prefMult := func(in EngineInput) (float64, string) {
		res := Evaluate(in)
		if len(res.Kept) != 1 {
			t.Fatalf("應保留，got %+v", res.Excluded)
		}
		for _, e := range res.Kept[0].Trace {
			if e.Factor == "preference" {
				return e.Mult, e.Reason
			}
		}
		t.Fatal("缺 preference trace")
		return 0, ""
	}
	// 無滿足度資料：一半命中 → 0.6 + 0.9*0.5 = 1.05
	if m, reason := prefMult(in); m < 1.049 || m > 1.051 || strings.Contains(reason, "公平") {
		t.Fatalf("無資料不應校正，got %v %q", m, reason)
	}
	// u1 最不滿足（且差距 ≥ FairnessMinGap）→ u1 權重 2：ratio 2/3 → 0.6 + 0.9*(2/3) = 1.2
	// trace 匿名（D7）：說有校正、不說是誰
	in.Satisfaction = map[string]float64{"u1": 0.2, "u2": 0.8}
	if m, reason := prefMult(in); m < 1.199 || m > 1.201 ||
		!strings.Contains(reason, "公平校正") || strings.Contains(reason, "小明") {
		t.Fatalf("應匿名加重 u1，got %v %q", m, reason)
	}
	// 差距小於 FairnessMinGap → 不校正
	in.Satisfaction = map[string]float64{"u1": 0.50, "u2": 0.55}
	if m, _ := prefMult(in); m < 1.049 || m > 1.051 {
		t.Fatalf("差距不足不應校正，got %v", m)
	}
	// 只有一人有 EMA → 不校正（沒得比較）
	in.Satisfaction = map[string]float64{"u1": 0.2}
	if m, _ := prefMult(in); m < 1.049 || m > 1.051 {
		t.Fatalf("單人資料不應校正，got %v", m)
	}
	// D22/OV#8：最低者沒填偏好 → 加重是 no-op，不選拔、不宣告假校正
	in.Members[0].Cuisines = nil // u1 空偏好
	in.Satisfaction = map[string]float64{"u1": 0.1, "u2": 0.9}
	if _, reason := prefMult(in); strings.Contains(reason, "公平校正") {
		t.Fatalf("空偏好成員不應觸發公平校正宣告，got %q", reason)
	}
}

func TestNewFactorsChangeOutcome(t *testing.T) {
	probOf := func(in EngineInput, key string) float64 {
		t.Helper()
		for _, c := range Evaluate(in).Kept {
			if c.PlaceID == key {
				return c.Probability
			}
		}
		t.Fatalf("%s 不在 kept", key)
		return 0
	}
	near := rest(func(r *Restaurant) { r.PlaceID = "near" })
	far := rest(func(r *Restaurant) { r.PlaceID = "far"; r.Lat = 25.0586 }) // ~1.2km
	base := func() EngineInput {
		return EngineInput{Restaurants: []Restaurant{near, far}, Members: []Member{member(nil)},
			Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170}
	}

	t.Run("大雨天讓遠的步行選項掉 ≥5%", func(t *testing.T) {
		dry, wet := base(), base()
		wet.Weather = &Weather{RainMM: 5}
		if diff := probOf(dry, "far") - probOf(wet, "far"); diff < 0.05 {
			t.Fatalf("weather 位移不足：%v", diff)
		}
	})
	t.Run("explore 檔新出現店家加成 ≥3%", func(t *testing.T) {
		off, on := base(), base()
		on.Exploration = "explore"
		on.Exposure = map[string]ExposureCount{"near": {}, "far": {Recommended: 5}}
		if diff := probOf(on, "near") - probOf(off, "near"); diff < 0.03 {
			t.Fatalf("new-store 位移不足：%v", diff)
		}
	})
	t.Run("人均熟店降權 ≥2%（spec 輕降權）", func(t *testing.T) {
		off, on := base(), base()
		on.Exposure = map[string]ExposureCount{"near": {Recommended: 9, Chosen: 5}, "far": {Recommended: 9}}
		if diff := probOf(off, "near") - probOf(on, "near"); diff < 0.02 {
			t.Fatalf("chosen-penalty 位移不足：%v", diff)
		}
	})
	t.Run("早餐時段加成 ≥3%", func(t *testing.T) {
		bf := rest(func(r *Restaurant) { r.PlaceID = "bf"; r.CuisineTags = []string{"breakfast", "japanese"} })
		off, on := base(), base()
		off.Restaurants = []Restaurant{near, bf}
		on.Restaurants = []Restaurant{near, bf}
		on.Now = at(time.Monday, 8, 0)
		if diff := probOf(on, "bf") - probOf(off, "bf"); diff < 0.03 {
			t.Fatalf("timeslot 位移不足：%v", diff)
		}
	})
	t.Run("公平校正拉抬最低者偏好 ≥5%", func(t *testing.T) {
		jp := rest(func(r *Restaurant) { r.PlaceID = "jp" })
		tw := rest(func(r *Restaurant) { r.PlaceID = "tw"; r.CuisineTags = []string{"taiwanese"} })
		mk := func() EngineInput {
			return EngineInput{Restaurants: []Restaurant{jp, tw},
				Members: []Member{member(nil),
					member(func(m *Member) { m.UserID = "u2"; m.Cuisines = []string{"taiwanese"} })},
				Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170}
		}
		off, on := mk(), mk()
		on.Satisfaction = map[string]float64{"u1": 0.2, "u2": 0.8}
		if diff := probOf(on, "jp") - probOf(off, "jp"); diff < 0.05 {
			t.Fatalf("fairness 位移不足：%v", diff)
		}
	})
}

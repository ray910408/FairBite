package main

import (
	"fmt"
	"math"
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
		{"價位超過最低偏好", rest(func(r *Restaurant) { r.PriceLevel = 4 }),
			[]Member{member(nil), member(func(m *Member) { m.UserID = "u2"; m.BudgetMax = 200 })},
			"budget", "高價"},
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

func TestBudgetMaxGooglePriceLevel(t *testing.T) {
	for _, tc := range []struct {
		budget, want int
	}{
		{50, PriceLevelUnknown},
		{100, 1}, {200, 1}, {300, 2}, {400, 2},
		{500, 3}, {800, 3}, {900, 4}, {1600, 4},
	} {
		t.Run(fmt.Sprintf("%d", tc.budget), func(t *testing.T) {
			if got := BudgetMaxGooglePriceLevel(tc.budget); got != tc.want {
				t.Errorf("BudgetMaxGooglePriceLevel(%d) = %d, want %d", tc.budget, got, tc.want)
			}
		})
	}
}

func TestBudgetGooglePriceLevelFilter(t *testing.T) {
	type testCase struct {
		name               string
		budget, priceLevel int
		wantExcluded       bool
	}
	cases := []testCase{
		{"same price level kept", 200, 1, false},
		{"higher than preference excluded", 200, 2, true},
		{"unknown price kept", 100, PriceLevelUnknown, false},
	}
	for budget := 100; budget <= 1600; budget += 100 {
		cases = append(cases, testCase{fmt.Sprintf("free at budget %d", budget), budget, 0, false})
	}
	for level := 0; level <= 4; level++ {
		cases = append(cases, testCase{fmt.Sprintf("unset preference at level %d", level), 50, level, false})
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			res := Evaluate(EngineInput{Restaurants: []Restaurant{rest(func(r *Restaurant) { r.PriceLevel = tc.priceLevel })}, Members: []Member{member(func(m *Member) { m.BudgetMax = tc.budget })}, Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170})
			if tc.wantExcluded {
				if len(res.Excluded) != 1 || len(res.Kept) != 0 || !hasKind(res.Excluded[0].Kinds, "budget") {
					t.Fatalf("expected budget exclusion: %+v", res)
				}
				reason := res.Excluded[0].Reason
				if strings.Contains(reason, "NT$") || !strings.Contains(reason, "偏好") {
					t.Errorf("expected qualitative price label, got %q", reason)
				}
			} else if len(res.Kept) != 1 || len(res.Excluded) != 0 {
				t.Fatalf("expected candidate kept: %+v", res)
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
	ms := []Member{member(func(m *Member) { m.Dietary = []string{"vegetarian"}; m.BudgetMax = 200 })}
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
					!strings.Contains(res.Excluded[0].Reason, "用餐時間未營業") {
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
		if len(c.Trace) != 4 {
			t.Errorf("%s trace 應有 4 個公開因素，got %d", c.PlaceID, len(c.Trace))
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

func TestDistFactor(t *testing.T) {
	for _, tc := range []struct {
		name          string
		lng           float64
		members       []Member
		wantMult      float64
		wantReasons   []string
		checkOverhead bool
	}{
		{"near clamp", 121.5170, []Member{member(nil)}, DistMultBest, nil, false},
		{"far clamp", 121.5430, []Member{member(nil)}, DistMultWorst, nil, false},
		{"slowest member", 121.5319, []Member{member(nil), member(func(m *Member) { m.UserID = "u2"; m.Transport = "transit" })}, 0, []string{"最慢", "步行"}, false},
		{"transit overhead", 121.5319, []Member{member(func(m *Member) { m.Transport = "transit" })}, 0, nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := rest(func(r *Restaurant) { r.Lat = 25.0478; r.Lng = tc.lng })
			entry := distFactor(r, EngineInput{Members: tc.members, CenterLat: 25.0478, CenterLng: 121.5170})
			if tc.wantMult != 0 && entry.Mult != tc.wantMult {
				t.Fatalf("mult = %v, want %v", entry.Mult, tc.wantMult)
			}
			for _, reason := range tc.wantReasons {
				if !strings.Contains(entry.Reason, reason) {
					t.Errorf("reason %q missing %q", entry.Reason, reason)
				}
			}
			if tc.checkOverhead && !strings.Contains(entry.Reason, "16 分鐘") && !strings.Contains(entry.Reason, "15 分鐘") {
				t.Fatalf("overhead missing: %q", entry.Reason)
			}
		})
	}
}

// trace 是 room_candidates.weight_breakdown 的內容（db.go ReplaceCandidates 原樣 marshal
// Candidate.Trace），也是 search/vote HTTP 回應裡的 trace（handlers.go resultJSON）。
// 兩條路都對同房成員開放，而 distance/weather 的倍率與 reason 都是「候選到圓心距離」的
// 單調確定性函數 → 反推 dist → 三家以上候選三角定位還原圓心 = 房主建房當下的精確位置。
// 這裡釘住的是：所有圓心衍生的公開值都同源於「量化後的圓心」。
//
// 2026-08-12 翻面（其二）：上一輪這條測試釘的是「量化每個候選到圓心的距離」。reviewer 指出
// 那還不夠——每個候選公布的是「圓心到我的距離落在某個 300 公尺寬的環帶」，N 個候選就是 N 條
// 以各自公開座標為心的環帶，圓心在交集裡；幾何條件好時交集遠小於一格，候選越多越窄。
// 現在改成量化圓心本身一次、之後不再捨入距離，公開值全部是單一網格點的函數。
// （更早的一次翻面：計分曾用全精度、只量化 trace，被 probability 比值繞過去。）
func TestCenterDerivedPublicValuesShareSnappedCenter(t *testing.T) {
	a := rest(func(r *Restaurant) { r.PlaceID = "a"; r.Lat = 25.0568 })
	b := rest(func(r *Restaurant) { r.PlaceID = "b"; r.Lat = 25.0595 })
	// 兩家除了位置以外完全相同（同 tags/價位/營業時間、無投票與曝光/近期資料）。
	// 下雨讓 weather 那條通道也上場。
	in := EngineInput{Restaurants: []Restaurant{a, b}, Members: []Member{member(nil)},
		Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
		Weather: &Weather{RainMM: 2.0}}
	res := Evaluate(in)
	if len(res.Kept) != 2 {
		t.Fatalf("兩家都應保留，got excluded %+v", res.Excluded)
	}
	prob, score := map[string]float64{}, map[string]float64{}
	traceProduct := map[string]float64{}
	trace := map[string]map[string]TraceEntry{}
	for _, c := range res.Kept {
		prob[c.PlaceID], score[c.PlaceID], traceProduct[c.PlaceID] = c.Probability, c.Score, 1
		trace[c.PlaceID] = map[string]TraceEntry{}
		for _, e := range c.Trace {
			trace[c.PlaceID][e.Factor] = e
			traceProduct[c.PlaceID] *= e.Mult
		}
	}

	// 手算對照（刻意不呼叫 snapCenter/distFactor/rainFactor，否則對照會跟著實作一起漂）：
	// 圓心網格：緯度格寬 300/111320 = 0.00269493 度，25.0478/0.00269493 = 9294.40 → 格點 9294
	//   → 9294*300/111320 = 25.0467122 度。
	// 經度格寬 300/(111320*cos 25.0467122°) = 0.00297466 度，121.5170/0.00297466 = 40850.66
	//   → 格點 40851 → 121.5179180 度。量化圓心距真實圓心 152 公尺。
	// a 到量化圓心的大圓距離 1124.04 公尺（到真實圓心是 1000.96），單一步行成員
	// （75 公尺/分、overhead 0）→ 14.987 分鐘。
	//   distance：1.2 + (0.7-1.2)*(14.987-5)/20 = 0.95032
	//   weather ：1 - (1-0.7)*(14.987-5)/15     = 0.80026
	// 若改用真實圓心會是 13.35 分鐘 → 0.99135 / 0.83308，且 reason 會寫「13 分鐘」——
	// 差距是容許誤差的 400 倍，這條對照分辨得出來。
	for _, c := range []struct {
		factor string
		mult   float64
		reason string
	}{
		{"distance", 0.95032, "平均交通約 15 分鐘（最慢 15 分鐘，步行）"},
		{"weather", 0.80026, ""},
	} {
		got := trace["a"][c.factor]
		// 1e-4 對應約 0.3 公尺的距離解析度：手算距離只寫到小數點後兩位，容許誤差取到這裡。
		if math.Abs(got.Mult-c.mult) > 1e-4 {
			t.Errorf("a 的 %s 倍率 = %v，從量化圓心（1124.04m）算應為 %v", c.factor, got.Mult, c.mult)
		}
		// reason 的「平均交通約 N 分鐘」是第二條旁通道（步行約 ±80 公尺），必須同源於量化距離。
		if c.reason != "" && got.Reason != c.reason {
			t.Errorf("a 的 %s reason = %q，應為 %q", c.factor, got.Reason, c.reason)
		}
	}

	// 同源不變式：Score（→ Probability）只能是 trace 裡那些倍率的乘積，不准有第二個版本。
	// 早先的全精度計分正是在這裡露餡：trace 是量化值、Score 是全精度值，對不起來。
	for _, id := range []string{"a", "b"} {
		if math.Abs(score[id]-traceProduct[id]) > 1e-12 {
			t.Errorf("%s 的 Score %v ≠ trace 倍率乘積 %v：計分與 trace 不同源，機率比值會洩漏網格以下的距離",
				id, score[id], traceProduct[id])
		}
	}
	if got, want := prob["a"]/prob["b"], traceProduct["a"]/traceProduct["b"]; math.Abs(got-want) > 1e-12 {
		t.Errorf("機率比值 %v 應等於 trace 倍率比值 %v", got, want)
	}
	// 幾何有效性：兩家距離不同，距離因素確實還有分辨力（否則上面全是零假設）。
	if trace["a"]["distance"] == trace["b"]["distance"] {
		t.Fatalf("測試幾何無效：兩家的 distance entry 應不同")
	}
}

// 本輪的核心不變式：兩個真實圓心只要落在同一個圓心網格，對同一組候選就必須產出「逐位相同」
// 的 trace 與機率。這是量化圓心（而非量化距離）唯一想買到的東西——公開的一切都是那個網格點
// 的函數，攻擊者能精確還原網格點，但網格以下的資訊一位元都沒外流，而且這個界限與候選數量、
// 幾何條件無關。
//
// 它同時證明了環帶交集也還原不出網格以下的資訊：舊做法（量化每個候選各自到圓心的距離）下，
// 每家候選公布一條 300 公尺寬的環帶，多條環帶交集可以遠比一格窄；那個做法會在這條測試翻紅，
// 因為圓心從 A 移到 B 時，距離跨過量化邊界的候選（下面的 n1、n2）倍率就變了。
func TestSameCenterGridInputsIdentical(t *testing.T) {
	// 兩個真實圓心都落在格點 (9294, 40851) = (25.0467122, 121.5179180) 這一格內：
	//   緯度：25.0457122/0.00269493 = 9293.63 → 9294 ✓、25.0477122/0.00269493 = 9294.37 → 9294 ✓
	//   經度：121.5169180/0.00297466 = 40850.66 → 40851 ✓、121.5189180/0.00297466 = 40851.34 ✓
	// 兩者相距 300 公尺（幾乎是一整格寬），是「同格但差很多」的最壞情況。
	centerA := [2]float64{25.0457122, 121.5169180}
	centerB := [2]float64{25.0477122, 121.5189180}
	if d := Haversine(centerA[0], centerA[1], centerB[0], centerB[1]); d < 200 {
		t.Fatalf("測試幾何無效：兩圓心只差 %.0f 公尺，量化與否分辨不出來", d)
	}
	// n1/n2 刻意選在「到 A 與到 B 的距離會落在不同 300 公尺距離桶」的位置
	//   （A：868m/1160m、B：598m/1003m → 舊做法量化成 900/1200 對 600/900）。
	// 少了它們，退回量化距離的做法會僥倖通過這條測試。
	cands := []Restaurant{
		rest(func(r *Restaurant) { r.PlaceID = "p1" }),
		rest(func(r *Restaurant) { r.PlaceID = "n1"; r.Lat = 25.0530; r.Lng = 121.5200 }),
		rest(func(r *Restaurant) { r.PlaceID = "n2"; r.Lat = 25.0560; r.Lng = 121.5150 }),
	}
	run := func(center [2]float64) map[string]Candidate {
		res := Evaluate(EngineInput{Restaurants: cands, Members: []Member{member(nil)},
			Now: lunchMonday, CenterLat: center[0], CenterLng: center[1],
			Weather: &Weather{RainMM: 2.0}}) // 下雨讓 weather 那條通道也上場
		if len(res.Kept) != len(cands) {
			t.Fatalf("三家都應保留，got excluded %+v", res.Excluded)
		}
		byID := map[string]Candidate{}
		for _, c := range res.Kept {
			byID[c.PlaceID] = c
		}
		return byID
	}
	gotA, gotB := run(centerA), run(centerB)

	for _, id := range []string{"p1", "n1", "n2"} {
		a, b := gotA[id], gotB[id]
		// 逐位相等而非近似：任何殘留的全精度距離都會讓最低位不同，近似比較會放它過去。
		if a.Probability != b.Probability || a.Score != b.Score {
			t.Errorf("%s 的機率/分數隨同格內的圓心位移改變：%v/%v vs %v/%v"+
				"（可用機率比值把圓心細分到網格以下）", id, a.Probability, a.Score, b.Probability, b.Score)
		}
		if len(a.Trace) != len(b.Trace) {
			t.Fatalf("%s 的 trace 長度不同：%d vs %d", id, len(a.Trace), len(b.Trace))
		}
		for i := range a.Trace {
			if a.Trace[i] != b.Trace[i] { // TraceEntry 是可比較的值型別，Reason 字串一併比對
				t.Errorf("%s 的 trace[%d] 隨同格內的圓心位移改變：%+v vs %+v",
					id, i, a.Trace[i], b.Trace[i])
			}
		}
	}
	// 幾何有效性：三家的 distance 必須互不相同，否則上面比的是三個常數。
	seen := map[float64]string{}
	for _, id := range []string{"p1", "n1", "n2"} {
		for _, e := range gotA[id].Trace {
			if e.Factor != "distance" {
				continue
			}
			if prev, dup := seen[e.Mult]; dup {
				t.Fatalf("測試幾何無效：%s 與 %s 的 distance 倍率相同（%v）", prev, id, e.Mult)
			}
			seen[e.Mult] = id
		}
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
	if entry := closingFactor(soon, EngineInput{Now: lunchMonday}); entry.Reason != "12:30 打烊" {
		t.Errorf("打烊理由應顯示絕對時刻，got %q", entry.Reason)
	}
}

func TestEvaluateVotes(t *testing.T) {
	for _, tc := range []struct {
		name  string
		votes map[string]VoteInfo
		veto  bool
		boost float64
		solo  bool
	}{
		{"two up votes boost score", map[string]VoteInfo{"a": {Ups: 2}}, false, 1 + 2*VoteBoostPerUp, false},
		{"veto removes candidate", map[string]VoteInfo{"a": {Vetoers: []string{"小明", "小華"}}}, true, 0, false},
		{"nil votes keep candidates neutral", nil, false, 1, false},
		{"solo nil votes", nil, false, 1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			a := rest(func(r *Restaurant) { r.PlaceID = "a" })
			b := rest(func(r *Restaurant) { r.PlaceID = "b" })
			restaurants := []Restaurant{a, b}
			if tc.solo {
				restaurants = restaurants[:1]
			}
			res := Evaluate(EngineInput{Restaurants: restaurants, Members: []Member{member(nil)}, Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170, Votes: tc.votes})
			if tc.solo {
				if len(res.Kept) != 1 {
					t.Fatalf("nil votes excluded solo candidate: %+v", res.Excluded)
				}
				return
			}
			if tc.veto {
				if len(res.Kept) != 1 || res.Kept[0].PlaceID != "b" || len(res.Excluded) != 1 {
					t.Fatalf("veto kept=%+v excluded=%+v", res.Kept, res.Excluded)
				}
				e := res.Excluded[0]
				if !hasKind(e.Kinds, "veto") || e.Reason != "遭 小明、小華 否決（可收回）" {
					t.Errorf("veto exclusion=%+v", e)
				}
				if p := res.Kept[0].Probability; p < 0.9999 || p > 1.0001 {
					t.Errorf("only candidate probability=%f, want 1", p)
				}
				return
			}
			if len(res.Kept) != 2 {
				t.Fatalf("expected both candidates: %+v", res)
			}
			byID := map[string]Candidate{}
			for _, c := range res.Kept {
				byID[c.PlaceID] = c
				if len(c.Trace) != 4 {
					t.Errorf("%s public trace length=%d, want 4", c.PlaceID, len(c.Trace))
				}
			}
			want := byID["b"].Score * tc.boost
			if got := byID["a"].Score; math.Abs(got-want) > 0.0001 {
				t.Errorf("score=%f, want %f", got, want)
			}
		})
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
		{"mixed fresh and fading private reason", RecencyCount{Fresh: 1, Fading: 2}, "balanced", 4, 0.65},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			in := recencyIn(c.rc, c.expl, c.n)
			got := recencyMult(t, in)
			for _, entry := range Evaluate(in).Kept[0].Trace {
				if entry.Factor == "recency" && entry.Reason != "依群體近期用餐概況調整" {
					t.Errorf("recency reason=%q", entry.Reason)
				}
			}
			if got < c.want-0.0001 || got > c.want+0.0001 {
				t.Errorf("want %f got %f", c.want, got)
			}
		})
	}
}

// 場上固定放一家「舊店」（Recommended>0）：新店加成只在混合場景有相對意義，
// 全場皆新時會被正規化抵銷、應為中性（D21）——單獨測 p1 時需要這個對照組。
func exposureIn(c ExposureCount, exploration string) EngineInput {
	old := rest(func(r *Restaurant) { r.PlaceID = "p-old" })
	return EngineInput{Restaurants: []Restaurant{rest(nil), old}, Members: []Member{member(nil), member(nil), member(nil), member(nil)},
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
		{"熟店_粗分組", ExposureCount{Recommended: 30, Chosen: 8}, "balanced", 0.95, true}, // 4 人房 8/20 -> 0.5 bucket
		{"熟店_達門檻", ExposureCount{Recommended: 30, Chosen: 20}, "balanced", 0.9, true},
		{"熟店_explore加重", ExposureCount{Recommended: 30, Chosen: 20}, "explore", 0.85, true},
		{"熟店_familiar關閉", ExposureCount{Recommended: 30, Chosen: 20}, "familiar", 1.0, false},
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

func TestExposureContext(t *testing.T) {
	for _, tc := range []struct {
		name      string
		count     ExposureCount
		setup     func(*EngineInput)
		want      float64
		wantTrace bool
	}{
		{"nil history", ExposureCount{}, func(in *EngineInput) { in.Exposure = nil }, 1, false},
		{"all new", ExposureCount{}, func(in *EngineInput) { in.Exposure["p-old"] = ExposureCount{} }, 1, false},
		{"excluded old candidate cannot enable bonus", ExposureCount{}, func(in *EngineInput) { in.Restaurants[1].PriceLevel = 4 }, 1, false},
		{"own search baseline remains new", ExposureCount{Recommended: 4}, func(in *EngineInput) { in.ExposureCounted = map[string]bool{"p1": true} }, 1.1, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			in := exposureIn(tc.count, "balanced")
			tc.setup(&in)
			got, hasTrace := exposureMult(t, in)
			if got != tc.want || hasTrace != tc.wantTrace {
				t.Fatalf("mult=%v trace=%v, want %v/%v", got, hasTrace, tc.want, tc.wantTrace)
			}
		})
	}
}

func TestExposureBaselineDoesNotSubtractCandidateExcludedAtSearch(t *testing.T) {
	in := exposureIn(ExposureCount{Recommended: 2}, "balanced")
	in.Members = append(in.Members, member(func(m *Member) { m.UserID = "u2" }))
	// p1 搜尋時遭排除，沒有收到本房曝光 +1，因此不在 counted 集合。
	in.ExposureCounted = map[string]bool{"p-old": true}

	entry := exposureFactor(in.Restaurants[0], in)
	if entry.Mult != 1.0 || strings.Contains(entry.Reason, "新出現") {
		t.Fatalf("搜尋時被排除的候選不可扣 baseline 或取得新店加成：got %+v", entry)
	}
}

// 五人房吃過一次 ≠ 吃滿懲罰（D21/OV#5：人均門檻）
func TestChosenPenaltyIsPerCapita(t *testing.T) {
	in := exposureIn(ExposureCount{Recommended: 9, Chosen: 1}, "balanced")
	in.Members = append(in.Members, member(func(m *Member) { m.UserID = "u5" }))
	got, hasTrace := exposureMult(t, in)
	want := 1.0 // 1/(5*5) = 0.04 -> neutral coarse bucket
	if !hasTrace || got < want-1e-9 || got > want+1e-9 {
		t.Fatalf("五人房 Chosen=1 應僅極輕降權：got %v want %v", got, want)
	}
	if entry := exposureFactor(in.Restaurants[0], in); entry.Reason != "依群體曝光概況調整" {
		t.Fatalf("中選 trace 不應公開精確人次：got %q", entry.Reason)
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
		// 距離從量化圓心（25.0467122, 121.5179180）起算 = 1323.8 公尺（真實圓心是 1201.1），
		// 步行 75 公尺/分 → 17.65 分鐘 → 1 - 0.3*(17.65-5)/15 = 0.747。
		{"雨天步行遠_降權", rainIn(rain, "walking", 25.0586), 0.747, true},
		{"雨天開車_中性無trace", rainIn(rain, "driving", 25.0586), 1.0, false},
		// 160.4 公尺 → 2.14 分鐘，未達 RainWalkFreeMin，但仍出 trace（「雨天，但步行距離近」）
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
		if !hasTrace || got < 0.868 || got > 0.878 { // (0.747 + 1.0) / 2 ≈ 0.873
			t.Fatalf("got %v trace=%v, want ≈0.873", got, hasTrace)
		}
	})
}

func TestTimeSlotFactor(t *testing.T) {
	for _, tc := range []struct {
		name      string
		now       time.Time
		tags      []string
		wantTrace bool
	}{
		{"早餐命中", at(time.Monday, 8, 0), []string{"breakfast", "taiwanese"}, true},
		{"午餐不加成", lunchMonday, []string{"breakfast"}, false},
		{"早餐未命中", at(time.Monday, 8, 0), []string{"japanese"}, false},
		{"晚餐時段已移除", at(time.Monday, 19, 0), []string{"hotpot"}, false},
		{"05:59 尚未開始", at(time.Monday, 5, 59), []string{"breakfast"}, false},
		{"06:00 開始", at(time.Monday, 6, 0), []string{"breakfast"}, true},
		{"10:59 尚未結束", at(time.Monday, 10, 59), []string{"breakfast"}, true},
		{"11:00 結束", at(time.Monday, 11, 0), []string{"breakfast"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := Evaluate(EngineInput{Restaurants: []Restaurant{rest(func(r *Restaurant) { r.CuisineTags = tc.tags })}, Members: []Member{member(nil)}, Now: tc.now, CenterLat: 25.0478, CenterLng: 121.5170})
			if len(res.Kept) != 1 {
				t.Fatalf("expected kept candidate: %+v", res.Excluded)
			}
			found := false
			for _, e := range res.Kept[0].Trace {
				if e.Factor == "timeslot" {
					found = true
					if e.Mult != TimeSlotBoostMult {
						t.Errorf("mult = %v, want %v", e.Mult, TimeSlotBoostMult)
					}
				}
			}
			if found != tc.wantTrace {
				t.Fatalf("trace presence = %v, want %v", found, tc.wantTrace)
			}
		})
	}
}

func TestSatisfactionEMA(t *testing.T) {
	for _, tc := range []struct {
		name            string
		samples         []float64
		want, tolerance float64
	}{
		{"single sample initializes EMA", []float64{1}, 1, 0},
		{"fold oldest to newest", []float64{1, 0}, 0.7, 0.001},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := satisfactionEMA(tc.samples); math.Abs(got-tc.want) > tc.tolerance {
				t.Fatalf("EMA = %v, want %v", got, tc.want)
			}
		})
	}
}

func TestPrefFairnessBoost(t *testing.T) {
	for _, tc := range []struct {
		name                    string
		satisfaction            map[string]float64
		emptyFirst, emptySecond bool
		want                    float64
		wantFairness            bool
	}{
		{"無資料", nil, false, false, 1.05, false},
		{"最低者加重且匿名", map[string]float64{"u1": 0.2, "u2": 0.8}, false, false, 1.2, true},
		{"差距不足", map[string]float64{"u1": 0.50, "u2": 0.55}, false, false, 1.05, false},
		{"只有單人資料", map[string]float64{"u1": 0.2}, false, false, 1.05, false},
		{"最低者空偏好不宣告校正", map[string]float64{"u1": 0.1, "u2": 0.9}, true, false, 0, false},
		{"空偏好者仍納入比較", map[string]float64{"u1": 0.2, "u2": 0.8}, false, true, 1.2, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ms := []Member{member(nil), member(func(m *Member) { m.UserID = "u2"; m.DisplayName = "小華"; m.Cuisines = []string{"taiwanese"} })}
			if tc.emptyFirst {
				ms[0].Cuisines = nil
			}
			if tc.emptySecond {
				ms[1].Cuisines = nil
			}
			result := Evaluate(EngineInput{Restaurants: []Restaurant{rest(nil)}, Members: ms, Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170, Satisfaction: tc.satisfaction})
			if len(result.Kept) != 1 {
				t.Fatalf("expected kept candidate: %+v", result)
			}
			for _, e := range result.Kept[0].Trace {
				if e.Factor != "preference" {
					continue
				}
				if tc.want != 0 && math.Abs(e.Mult-tc.want) > 0.001 {
					t.Errorf("mult = %v, want %v", e.Mult, tc.want)
				}
				if strings.Contains(e.Reason, "公平") != tc.wantFairness || (tc.wantFairness && (!strings.Contains(e.Reason, "公平校正") || strings.Contains(e.Reason, "小明"))) {
					t.Errorf("unexpected fairness reason: %q", e.Reason)
				}
				return
			}
			t.Fatal("trace 缺 preference 因素")
		})
	}
}

func TestNewFactorsChangeOutcome(t *testing.T) {
	probOf := func(t *testing.T, in EngineInput, key string) float64 {
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
		return EngineInput{Restaurants: []Restaurant{near, far}, Members: []Member{member(nil), member(nil), member(nil), member(nil)},
			Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170}
	}

	for _, tc := range []struct {
		name, key string
		minimum   float64
		decrease  bool
		inputs    func() (EngineInput, EngineInput)
	}{
		{"heavy rain demotes distant walking option", "far", 0.05, true, func() (EngineInput, EngineInput) {
			off, on := base(), base()
			on.Weather = &Weather{RainMM: 5}
			return off, on
		}},
		{"explore boosts new restaurant", "near", 0.03, false, func() (EngineInput, EngineInput) {
			off, on := base(), base()
			on.Exploration = "explore"
			on.Exposure = map[string]ExposureCount{"near": {}, "far": {Recommended: 5}}
			return off, on
		}},
		{"per-capita chosen penalty", "near", 0.02, true, func() (EngineInput, EngineInput) {
			off, on := base(), base()
			on.Exposure = map[string]ExposureCount{"near": {Recommended: 30, Chosen: 20}, "far": {Recommended: 30}}
			return off, on
		}},
		{"breakfast time boost", "bf", 0.03, false, func() (EngineInput, EngineInput) {
			bf := rest(func(r *Restaurant) { r.PlaceID = "bf"; r.CuisineTags = []string{"breakfast", "japanese"} })
			off, on := base(), base()
			off.Restaurants = []Restaurant{near, bf}
			on.Restaurants = []Restaurant{near, bf}
			on.Now = at(time.Monday, 8, 0)
			return off, on
		}},
		{"four-person fairness boosts least satisfied preference", "jp", 0.04, false, func() (EngineInput, EngineInput) {
			mk := func() EngineInput {
				return EngineInput{
					Restaurants: []Restaurant{rest(func(r *Restaurant) { r.PlaceID = "jp" }), rest(func(r *Restaurant) { r.PlaceID = "tw"; r.CuisineTags = []string{"taiwanese"} })},
					Members:     []Member{member(nil), member(func(m *Member) { m.UserID = "u3" }), member(func(m *Member) { m.UserID = "u4"; m.Cuisines = []string{"taiwanese"} }), member(func(m *Member) { m.UserID = "u2"; m.Cuisines = []string{"taiwanese"} })},
					Now:         lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
				}
			}
			off, on := mk(), mk()
			on.Satisfaction = map[string]float64{"u1": 0.2, "u2": 0.8}
			return off, on
		}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			off, on := tc.inputs()
			diff := probOf(t, on, tc.key) - probOf(t, off, tc.key)
			if tc.decrease {
				diff = -diff
			}
			if diff < tc.minimum {
				t.Fatalf("probability shift=%v, want at least %v", diff, tc.minimum)
			}
		})
	}
}

func TestCuisineFilterAndQueryMatches(t *testing.T) {
	ramenFan := Member{UserID: "u1", DisplayName: "小明", BudgetMax: 1600, Cuisines: []string{"ramen"}, MaxDistanceM: 3000, Transport: "walking"}
	noPref := Member{UserID: "u2", DisplayName: "無偏好", BudgetMax: 1600, MaxDistanceM: 3000, Transport: "walking"}
	taiwaneseFan := Member{UserID: "u-tw", DisplayName: "台菜", BudgetMax: 1600, Cuisines: []string{"taiwanese"}, MaxDistanceM: 3000, Transport: "walking"}
	veg := Member{UserID: "u4", DisplayName: "吃素", BudgetMax: 1600, Dietary: []string{"vegetarian"}, MaxDistanceM: 3000, Transport: "walking"}
	tagged := Restaurant{PlaceID: "p-tag", Name: "正牌拉麵", CuisineTags: []string{"japanese", "ramen"}, PriceLevel: 1, Hours: daily([2]int{0, 1440})}
	matched := Restaurant{PlaceID: "p-qm", Name: "麵框框", QueryMatches: []string{"ramen"}, PriceLevel: 1, Hours: daily([2]int{0, 1440})}
	other := Restaurant{PlaceID: "p-other", Name: "無關店", CuisineTags: []string{"korean"}, PriceLevel: 1, Hours: daily([2]int{0, 1440})}
	noodle := Restaurant{PlaceID: "p-tw-qm", Name: "台式麵店", CuisineTags: []string{}, QueryMatches: []string{"taiwanese"}, PriceLevel: 1, Hours: daily([2]int{0, 1440})}
	queryOnly := Restaurant{ID: "veg-query-only", Name: "素坊燒肉", CuisineTags: []string{"korean"}, QueryMatches: []string{"vegetarian"}, PriceLevel: 1, Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440})}
	canonical := Restaurant{ID: "veg-real", Name: "春天素食", CuisineTags: []string{"vegetarian_friendly", "taiwanese"}, PriceLevel: 1, Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440})}
	for _, tc := range []struct {
		name                 string
		restaurants          []Restaurant
		member               Member
		filter               bool
		wantKept             int
		wantKind, wantReason string
	}{
		{"filter accepts tags and query matches", []Restaurant{tagged, matched, other}, ramenFan, true, 2, "cuisine", "不符成員菜系偏好"},
		{"empty preference disables filter", []Restaurant{other}, noPref, true, 1, "", ""},
		{"filter off keeps unrelated cuisine", []Restaurant{other}, ramenFan, false, 1, "", ""},
		{"Taiwanese query evidence does not change canonical tags", []Restaurant{noodle}, taiwaneseFan, true, 1, "", ""},
		{"strict dietary rejects query-only evidence", []Restaurant{queryOnly}, veg, false, 0, "dietary", ""},
		{"strict dietary accepts canonical evidence", []Restaurant{canonical}, veg, false, 1, "", ""},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := Evaluate(EngineInput{Restaurants: tc.restaurants, Members: []Member{tc.member}, Now: lunchMonday, CuisineFilter: tc.filter})
			if len(res.Kept) != tc.wantKept {
				t.Fatalf("kept=%+v excluded=%+v, want %d kept", res.Kept, res.Excluded, tc.wantKept)
			}
			if tc.wantKind != "" {
				if len(res.Excluded) != 1 || !hasKind(res.Excluded[0].Kinds, tc.wantKind) || !strings.Contains(res.Excluded[0].Reason, tc.wantReason) {
					t.Fatalf("exclusions=%+v, want kind=%s reason containing %q", res.Excluded, tc.wantKind, tc.wantReason)
				}
			}
			for _, r := range res.Kept {
				if r.PlaceID == noodle.PlaceID && hasTag(r.CuisineTags, "taiwanese") {
					t.Fatal("room query evidence must not become canonical tag")
				}
			}
		})
	}
}

func TestMemberLikesQueryMatches(t *testing.T) {
	m := member(func(m *Member) { m.Cuisines = []string{"ramen"} })
	for _, tc := range []struct {
		name    string
		matches []string
		want    bool
	}{
		{"matching room query", []string{"ramen"}, true},
		{"unrelated room query", []string{"korean"}, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := memberLikes(m, Restaurant{QueryMatches: tc.matches}); got != tc.want {
				t.Fatalf("memberLikes=%v, want %v", got, tc.want)
			}
		})
	}
}

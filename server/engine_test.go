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
	for _, tc := range []struct {
		name               string
		budget, priceLevel int
		wantExcluded       bool
	}{
		{"同層級保留", 200, 1, false},
		{"高於偏好排除", 200, 2, true},
		{"未知價位保留", 100, PriceLevelUnknown, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			res := Evaluate(EngineInput{
				Restaurants: []Restaurant{rest(func(r *Restaurant) { r.PriceLevel = tc.priceLevel })},
				Members:     []Member{member(func(m *Member) { m.BudgetMax = tc.budget })},
				Now:         lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
			})
			if got := len(res.Excluded) == 1; got != tc.wantExcluded {
				t.Fatalf("excluded = %t, want %t: kept=%+v excluded=%+v", got, tc.wantExcluded, res.Kept, res.Excluded)
			}
			if tc.wantExcluded {
				reason := res.Excluded[0].Reason
				if strings.Contains(reason, "NT$") || !strings.Contains(reason, "偏好") {
					t.Errorf("預算排除理由必須是 qualitative labels，got %q", reason)
				}
			}
		})
	}
}

func TestBudgetGoogleFreePriceLevelNeverExcludes(t *testing.T) {
	for budget := 100; budget <= 1600; budget += 100 {
		t.Run(fmt.Sprintf("%d", budget), func(t *testing.T) {
			res := Evaluate(EngineInput{
				Restaurants: []Restaurant{rest(func(r *Restaurant) { r.PriceLevel = 0 })},
				Members:     []Member{member(func(m *Member) { m.BudgetMax = budget })},
				Now:         lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
			})
			if len(res.Kept) != 1 {
				t.Fatalf("Google level 0 在偏好刻度 %d 應保留，got excluded=%+v", budget, res.Excluded)
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
	in.ExposureCounted = map[string]bool{"p1": true}
	got, hasTrace := exposureMult(t, in)
	if !hasTrace || got != 1.1 {
		t.Fatalf("Recommended 等於本房 baseline 應視為新店：got %v trace=%v", got, hasTrace)
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
	// 空偏好者仍應計入比較域：u1 有偏好且較不滿足時，必須加重 u1。
	in.Members[0].Cuisines = []string{"japanese"}
	in.Members[1].Cuisines = nil
	in.Satisfaction = map[string]float64{"u1": 0.2, "u2": 0.8}
	if m, reason := prefMult(in); m < 1.199 || m > 1.201 || !strings.Contains(reason, "公平校正") {
		t.Fatalf("混合偏好房應加重 u1，got %v %q", m, reason)
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

func TestCuisineFilterAndQueryMatches(t *testing.T) {
	now := at(time.Monday, 12, 0)
	ramenFan := Member{UserID: "u1", DisplayName: "小明", BudgetMax: 1600, Cuisines: []string{"ramen"}, MaxDistanceM: 3000, Transport: "walking"}
	noPref := Member{UserID: "u2", DisplayName: "無偏好", BudgetMax: 1600, MaxDistanceM: 3000, Transport: "walking"}
	tagged := Restaurant{PlaceID: "p-tag", Name: "正牌拉麵", CuisineTags: []string{"japanese", "ramen"}, PriceLevel: 1, Hours: daily([2]int{0, 1440})}
	matched := Restaurant{PlaceID: "p-qm", Name: "麵框框", CuisineTags: nil, QueryMatches: []string{"ramen"}, PriceLevel: 1, Hours: daily([2]int{0, 1440})}
	other := Restaurant{PlaceID: "p-other", Name: "無關店", CuisineTags: []string{"korean"}, PriceLevel: 1, Hours: daily([2]int{0, 1440})}

	t.Run("query match 命中偏好因素", func(t *testing.T) {
		if !memberLikes(ramenFan, matched) {
			t.Fatal("query_matches 應納入 memberLikes 命中定義（spec §5.4）")
		}
	})
	t.Run("開關開：無關店被排除、kind=cuisine", func(t *testing.T) {
		res := Evaluate(EngineInput{Restaurants: []Restaurant{tagged, matched, other},
			Members: []Member{ramenFan}, Now: now, CuisineFilter: true})
		if len(res.Kept) != 2 {
			t.Fatalf("kept = %d, want 2（tags 命中＋query match 命中）", len(res.Kept))
		}
		if len(res.Excluded) != 1 || !hasKind(res.Excluded[0].Kinds, "cuisine") {
			t.Fatalf("無關店應以 cuisine kind 排除：%+v", res.Excluded)
		}
		if !strings.Contains(res.Excluded[0].Reason, "不符成員菜系偏好") {
			t.Fatalf("排除理由應含固定文案：%s", res.Excluded[0].Reason)
		}
	})
	t.Run("開關開但全員無偏好：不作用", func(t *testing.T) {
		res := Evaluate(EngineInput{Restaurants: []Restaurant{other},
			Members: []Member{noPref}, Now: now, CuisineFilter: true})
		if len(res.Kept) != 1 {
			t.Fatalf("聯集為空時開關不得排除任何店：%+v", res.Excluded)
		}
	})
	t.Run("開關關：無關店照常保留", func(t *testing.T) {
		res := Evaluate(EngineInput{Restaurants: []Restaurant{other},
			Members: []Member{ramenFan}, Now: now})
		if len(res.Kept) != 1 {
			t.Fatal("開關關時菜系不觸發排除（維持偏好制）")
		}
	})
	t.Run("台式 query match 是房間層證據、不改 canonical tag", func(t *testing.T) {
		taiwaneseFan := Member{UserID: "u-tw", DisplayName: "台菜", BudgetMax: 1600,
			Cuisines: []string{"taiwanese"}, MaxDistanceM: 3000, Transport: "walking"}
		noodle := Restaurant{PlaceID: "p-tw-qm", Name: "台式麵店", CuisineTags: []string{},
			QueryMatches: []string{"taiwanese"}, PriceLevel: 1, Hours: daily([2]int{0, 1440})}
		res := Evaluate(EngineInput{Restaurants: []Restaurant{noodle}, Members: []Member{taiwaneseFan},
			Now: now, CuisineFilter: true})
		if len(res.Kept) != 1 || hasTag(noodle.CuisineTags, "taiwanese") {
			t.Fatalf("Taiwanese query match must satisfy this room only: kept=%+v tags=%v", res.Kept, noodle.CuisineTags)
		}
	})
	t.Run("嚴格禁忌不吃 query match（vegetarian 側，對稱於上一案）", func(t *testing.T) {
		// Task 2 之後「素食」成為定向檢索詞，命中的店會拿到 QueryMatches ["vegetarian"]。
		// 那是文字相關性——店名帶「素」的葷餐廳就能拿到——不是素食認證。
		// engine.go hardExclude 的 DietaryRequires 只讀 canonical tags（ADR-0006），
		// 這個 case 就是把那條規定釘死：誤放行的後果是素食者吃到葷的。
		r := Restaurant{ID: "veg-query-only", Name: "素坊燒肉",
			CuisineTags: []string{"korean"}, QueryMatches: []string{"vegetarian"},
			PriceLevel: 1, Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440})}
		veg := Member{UserID: "u4", DisplayName: "吃素", BudgetMax: 1600,
			Dietary: []string{"vegetarian"}, MaxDistanceM: 3000, Transport: "walking"}
		res := Evaluate(EngineInput{Restaurants: []Restaurant{r}, Members: []Member{veg}, Now: now})
		if len(res.Kept) != 0 {
			t.Fatalf("query_match=vegetarian 不得滿足 DietaryRequires（canonical tag 才算）：%+v", res.Kept)
		}
		if !hasKind(res.Excluded[0].Kinds, "dietary") {
			t.Fatalf("應以 kind=dietary 排除，got %v", res.Excluded[0].Kinds)
		}
	})

	t.Run("正向保留：具 vegetarian_friendly canonical tag 應保留", func(t *testing.T) {
		// TODOS.md:109 記錄的既有缺口：引擎正向保留路徑無測試。
		// 沒有這一半，Task 3 收緊 tag 來源之後「收太緊」不會被任何測試發現。
		r := Restaurant{ID: "veg-real", Name: "春天素食",
			CuisineTags: []string{"vegetarian_friendly", "taiwanese"},
			PriceLevel:  1, Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440})}
		veg := Member{UserID: "u5", DisplayName: "吃素", BudgetMax: 1600,
			Dietary: []string{"vegetarian"}, MaxDistanceM: 3000, Transport: "walking"}
		res := Evaluate(EngineInput{Restaurants: []Restaurant{r}, Members: []Member{veg}, Now: now})
		if len(res.Kept) != 1 {
			t.Fatalf("具 vegetarian_friendly 的店應保留：%+v", res.Excluded)
		}
	})
}

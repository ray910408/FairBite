package main

import (
	"fmt"
	"strings"
	"time"
)

type Member struct {
	UserID       string
	DisplayName  string
	BudgetMax    int
	Cuisines     []string
	Dietary      []string
	MaxDistanceM int
	Transport    string
}

type VoteInfo struct {
	Ups     int
	Vetoers []string
}

type RecencyCount struct {
	Fresh  int
	Fading int
}

type ExposureCount struct {
	Recommended int // 房內成員 recommended_count 總和
	Chosen      int // 房內成員 chosen_count 總和
}

type TraceEntry struct {
	Factor string  `json:"factor"`
	Mult   float64 `json:"mult"`
	Reason string  `json:"reason"`
}

type Candidate struct {
	Restaurant
	Score       float64
	Probability float64
	Trace       []TraceEntry
}

type Excluded struct {
	Restaurant
	Kinds  []string // 全部命中的排除類別（dietary/budget/closed/veto），供統計不受檢查順序污染
	Reason string   // 全部原因以「；」串接，含成員歸因
}

func hasKind(ks []string, want string) bool {
	for _, k := range ks {
		if k == want {
			return true
		}
	}
	return false
}

type EngineInput struct {
	Restaurants          []Restaurant
	Members              []Member
	Now                  time.Time
	CenterLat, CenterLng float64
	Weather              *Weather                 // nil = 無資料（provider 失敗或未接），中性
	Votes                map[string]VoteInfo      // key = rkey(r)；nil = 無投票資料（P1 相容）
	Recency              map[string]RecencyCount  // key = rkey(r)；nil = 無紀錄
	Exposure             map[string]ExposureCount // key = rkey(r)；nil = 無統計（相容舊測試）
	ExposureBaseline     map[string]int           // vote/draw 僅為 search 時 kept（收到本房 +1）的候選填 len(members)；nil = 不扣
	Satisfaction         map[string]float64       // key = UserID；無樣本的成員不在 map；nil = 無資料
	Exploration          string                   // familiar/balanced/explore；"" 視為 balanced
}

type EngineResult struct {
	Kept     []Candidate
	Excluded []Excluded
}

func hasTag(tags []string, want string) bool {
	for _, t := range tags {
		if t == want {
			return true
		}
	}
	return false
}

// rkey：真實流程一律有 DB uuid；引擎測試無 DB 用 PlaceID
func rkey(r Restaurant) string {
	if r.ID != "" {
		return r.ID
	}
	return r.PlaceID
}

// hardExclude 收集「全部」違反的硬性條件（不是只記第一個）：
// 統計才不受檢查順序污染，且理由帶成員名，UI 能建議「誰」放寬什麼（spec §8）
func hardExclude(r Restaurant, ms []Member, now time.Time) (kinds, reasons []string) {
	seenKind := map[string]bool{}
	addKind := func(k string) {
		if !seenKind[k] {
			seenKind[k] = true
			kinds = append(kinds, k)
		}
	}
	for _, m := range ms {
		for _, d := range m.Dietary {
			if req, strict := DietaryRequires[d]; strict {
				if !hasTag(r.CuisineTags, req) {
					addKind("dietary")
					reasons = append(reasons, fmt.Sprintf("無 %s 認證標籤，%s（%s）無法用餐",
						req, m.DisplayName, DietaryLabels[d]))
				}
				continue
			}
			for _, conflict := range DietaryConflicts[d] {
				if hasTag(r.CuisineTags, conflict) {
					addKind("dietary")
					reasons = append(reasons, fmt.Sprintf("類型「%s」與 %s 的飲食禁忌（%s）衝突",
						conflict, m.DisplayName, DietaryLabels[d]))
				}
			}
		}
	}
	minBudget, minName := ms[0].BudgetMax, ms[0].DisplayName
	for _, m := range ms[1:] {
		if m.BudgetMax < minBudget {
			minBudget, minName = m.BudgetMax, m.DisplayName
		}
	}
	if r.PriceLevel >= 0 {
		if price := PriceLevelMaxTWD[r.PriceLevel]; price > minBudget {
			addKind("budget")
			reasons = append(reasons, fmt.Sprintf("價位約 NT$%d，超過 %s 的預算上限 NT$%d", price, minName, minBudget))
		}
	}
	// 比照未知價位先例：未知不排除，不能把缺少時段當成目前未營業。
	if len(r.Hours) > 0 && !r.Hours.IsOpenAt(now) {
		addKind("closed")
		reasons = append(reasons, "目前未營業")
	}
	return kinds, reasons
}

type factorFn func(r Restaurant, in EngineInput) TraceEntry

// satisfactionEMA：樣本由舊到新折入；第一筆為初始值。
// samples 非空（呼叫端保證；空輸入是程式錯誤，panic-fast 優於回傳假中性值，eng review D13）
func satisfactionEMA(samples []float64) float64 {
	ema := samples[0]
	for _, s := range samples[1:] {
		ema = EMAAlpha*s + (1-EMAAlpha)*ema
	}
	return ema
}

// lowestSatisfactionMember：至少兩位成員有 EMA 且差距達 FairnessMinGap 才校正；
// 冷啟動（無資料）或大家一樣滿意時不動（比照 D14 的誠實原則）。
// 迭代 in.Members（SQL 已按 user_id 排序）而非 map，平手時結果決定性。
func lowestSatisfactionMember(in EngineInput) string {
	if len(in.Satisfaction) < 2 {
		return ""
	}
	var lowID string
	low, high := 2.0, -1.0
	for _, m := range in.Members {
		if len(m.Cuisines) == 0 {
			// 無偏好可加重：選了也是 no-op 還宣告假校正（D22/OV#8）——不選拔、不宣告
			continue
		}
		s, ok := in.Satisfaction[m.UserID]
		if !ok {
			continue
		}
		if s < low {
			low, lowID = s, m.UserID
		}
		if s > high {
			high = s
		}
	}
	if high-low < FairnessMinGap {
		return ""
	}
	return lowID
}

// memberLikes：成員任一 cuisine 命中餐廳 tags。偏好因素與滿足度樣本（prefHit）
// 共用的唯一命中定義——兩者語意必須同步，改這裡即兩處同時生效（eng review D11）。
func memberLikes(m Member, r Restaurant) bool {
	for _, c := range m.Cuisines {
		if hasTag(r.CuisineTags, c) {
			return true
		}
	}
	return false
}

func prefFactor(r Restaurant, in EngineInput) TraceEntry {
	lowest := lowestSatisfactionMember(in)
	var wsum, hitsum float64
	hits := 0
	for _, m := range in.Members {
		w := 1.0
		if m.UserID == lowest {
			w = FairnessBoostWeight
		}
		wsum += w
		if memberLikes(m, r) {
			hitsum += w
			hits++
		}
	}
	ratio := hitsum / wsum
	mult := PrefMultMin + (PrefMultMax-PrefMultMin)*ratio
	reason := fmt.Sprintf("%d/%d 位成員偏好命中", hits, len(in.Members))
	if lowest != "" {
		// 匿名（eng review D7）：公開「有校正」維持可解釋性，
		// 但不公開誰的滿足度最低——那是個人資料，點名有社交成本。
		reason += "（已套用成員公平校正）"
	}
	return TraceEntry{"preference", mult, reason}
}

// travelMinutes：單一成員到某距離的通勤分鐘數（overhead + 距離/速度）。
// distFactor 與 rainFactor 共用——兩個因素對「通勤時間」的定義不許分岔（OV#23）。
func travelMinutes(m Member, distM float64) float64 {
	return TransportOverheadMin[m.Transport] + distM/TransportMetersPerMin[m.Transport]
}

func distFactor(r Restaurant, in EngineInput) TraceEntry {
	dist := Haversine(in.CenterLat, in.CenterLng, r.Lat, r.Lng)
	var sumMult, sumMin, worstMin float64
	worstTransport := in.Members[0].Transport
	for _, m := range in.Members {
		minutes := travelMinutes(m, dist)
		frac := (minutes - DistBestMin) / (DistWorstMin - DistBestMin)
		if frac < 0 {
			frac = 0
		}
		if frac > 1 {
			frac = 1
		}
		sumMult += DistMultBest + (DistMultWorst-DistMultBest)*frac
		sumMin += minutes
		if minutes > worstMin {
			worstMin, worstTransport = minutes, m.Transport
		}
	}
	n := float64(len(in.Members))
	return TraceEntry{"distance", sumMult / n,
		fmt.Sprintf("平均交通約 %.0f 分鐘（最慢 %.0f 分鐘，%s）",
			sumMin/n, worstMin, TransportLabels[worstTransport])}
}

func rainFactor(r Restaurant, in EngineInput) TraceEntry {
	if in.Weather == nil || in.Weather.RainMM < RainThresholdMM {
		return TraceEntry{Mult: 1.0}
	}
	dist := Haversine(in.CenterLat, in.CenterLng, r.Lat, r.Lng)
	var sum float64
	walkers := 0
	for _, m := range in.Members {
		if m.Transport != "walking" {
			sum += 1.0
			continue
		}
		walkers++
		minutes := travelMinutes(m, dist)
		frac := (minutes - RainWalkFreeMin) / (RainWalkWorstMin - RainWalkFreeMin)
		if frac < 0 {
			frac = 0
		}
		if frac > 1 {
			frac = 1
		}
		sum += 1 - (1-RainWalkPenaltyMult)*frac
	}
	if walkers == 0 {
		return TraceEntry{Mult: 1.0}
	}
	mult := sum / float64(len(in.Members))
	if mult > 0.999 {
		return TraceEntry{"weather", 1.0, "雨天，但步行距離近"}
	}
	return TraceEntry{"weather", mult, fmt.Sprintf("雨天，%d 位步行成員路程較遠", walkers)}
}

func timeSlotOf(t time.Time) string {
	for slot, hr := range TimeSlotHours { // slot 區間不重疊，map 迭代順序無關
		if h := t.Hour(); h >= hr[0] && h < hr[1] {
			return slot
		}
	}
	return ""
}

func timeSlotFactor(r Restaurant, in EngineInput) TraceEntry {
	slot := timeSlotOf(in.Now)
	if slot == "" {
		return TraceEntry{Mult: 1.0}
	}
	for _, tag := range TimeSlotBoosts[slot] {
		if hasTag(r.CuisineTags, tag) {
			return TraceEntry{"timeslot", TimeSlotBoostMult, TimeSlotLabels[slot] + "加成"}
		}
	}
	return TraceEntry{Mult: 1.0}
}

func closingFactor(r Restaurant, in EngineInput) TraceEntry {
	// 比照未知價位先例：未知不排除，也不臆測即將打烊。
	if len(r.Hours) == 0 {
		return TraceEntry{Mult: 1.0}
	}
	left := r.Hours.MinutesUntilClose(in.Now)
	if left >= 0 && left < ClosingSoonMinutes {
		return TraceEntry{"closing_soon", ClosingSoonMult,
			fmt.Sprintf("%d 分鐘後打烊", left)}
	}
	return TraceEntry{"closing_soon", 1.0, "營業時間充裕"}
}

func voteFactor(r Restaurant, in EngineInput) TraceEntry {
	ups := in.Votes[rkey(r)].Ups
	if ups == 0 {
		return TraceEntry{"votes", 1.0, "尚無贊成票"}
	}
	return TraceEntry{"votes", 1 + VoteBoostPerUp*float64(ups),
		fmt.Sprintf("%d 張贊成票", ups)}
}

func gearScale(scales map[string]float64, exploration string) float64 {
	if s, ok := scales[exploration]; ok {
		return s
	}
	return scales["balanced"]
}

// effectiveRecommended：扣掉該候選在本房 search 收到的自房 +1 後推薦次數（clamp 0）。
func effectiveRecommended(r Restaurant, c ExposureCount, in EngineInput) int {
	n := c.Recommended - in.ExposureBaseline[rkey(r)]
	if n < 0 {
		n = 0
	}
	return n
}

// allCandidatesNew：全場存活候選皆未被推薦過（區域首搜的常態）。
// ponytail: O(n²)（每家候選掃一次全場），n ≤ 數十，夠用
func allCandidatesNew(in EngineInput) bool {
	for _, r := range in.Restaurants {
		if effectiveRecommended(r, in.Exposure[rkey(r)], in) != 0 {
			return false
		}
	}
	return true
}

func exposureFactor(r Restaurant, in EngineInput) TraceEntry {
	if in.Exposure == nil {
		return TraceEntry{Mult: 1.0} // 無統計資料：中性且不產生 trace（比照 closingFactor 先例）
	}
	c := in.Exposure[rkey(r)]
	if effectiveRecommended(r, c, in) == 0 {
		scale := gearScale(NewStoreBonusScale, in.Exploration)
		if scale == 0 {
			return TraceEntry{Mult: 1.0} // 熟悉檔：新店加成關閉，不出 chip
		}
		// 全場皆新（區域首搜常態）：一致加成會在正規化後抵銷 → 中性且不出 chip，
		// 不產生虛構 trace（eng review D21/OV#7）。只有「舊場景中新出現的店」有相對加成。
		if allCandidatesNew(in) {
			return TraceEntry{Mult: 1.0}
		}
		return TraceEntry{"exposure", 1 + (NewStoreBonusMult-1)*scale, "新出現的店家"}
	}
	if c.Chosen == 0 {
		return TraceEntry{"exposure", 1.0, "推薦過但尚未中選"}
	}
	penaltyScale := gearScale(ChosenPenaltyScale, in.Exploration)
	if penaltyScale == 0 {
		return TraceEntry{Mult: 1.0} // 熟悉檔：熟店降權關閉（eng review D8），不出誤導性 chip
	}
	// 人均中選次數（D21/OV#5）：Chosen 是跨成員總和，不除人數會隨房間人數暴衝
	frac := float64(c.Chosen) / (float64(ChosenPenaltyAtCount) * float64(len(in.Members)))
	if frac > 1 {
		frac = 1
	}
	mult := 1 - (1-ChosenPenaltyMult)*frac*penaltyScale
	return TraceEntry{"exposure", mult, fmt.Sprintf("房內累計中選 %d 人次，稍作降權", c.Chosen)}
}

func recencyFactor(r Restaurant, in EngineInput) TraceEntry {
	c := in.Recency[rkey(r)]
	if c.Fresh == 0 && c.Fading == 0 {
		return TraceEntry{"recency", 1.0, "近 30 天無成員造訪"}
	}
	eff := (float64(c.Fresh) + RecencyFadingWeight*float64(c.Fading)) / float64(len(in.Members))
	scale := gearScale(RecencyPenaltyScale, in.Exploration)
	mult := 1 - (1-RecencyFloorMult)*eff*scale
	if mult < RecencyMinMult {
		mult = RecencyMinMult
	}
	var parts []string
	if c.Fresh > 0 {
		parts = append(parts, fmt.Sprintf("%d 位成員 14 天內造訪過", c.Fresh))
	}
	if c.Fading > 0 {
		parts = append(parts, fmt.Sprintf("%d 位成員 15–30 天前造訪過", c.Fading))
	}
	return TraceEntry{"recency", mult, strings.Join(parts, "；")}
}

var factors = []factorFn{prefFactor, distFactor, closingFactor, voteFactor, recencyFactor, exposureFactor, rainFactor, timeSlotFactor}

func Evaluate(in EngineInput) EngineResult {
	var res EngineResult
	survivors := make([]Restaurant, 0, len(in.Restaurants))
	for _, r := range in.Restaurants {
		if kinds, reasons := hardExclude(r, in.Members, in.Now); len(kinds) > 0 {
			res.Excluded = append(res.Excluded, Excluded{r, kinds, strings.Join(reasons, "；")})
			continue
		}
		if v := in.Votes[rkey(r)]; len(v.Vetoers) > 0 {
			res.Excluded = append(res.Excluded, Excluded{r, []string{"veto"},
				fmt.Sprintf("遭 %s 否決（可收回）", strings.Join(v.Vetoers, "、"))})
			continue
		}
		survivors = append(survivors, r)
	}
	in.Restaurants = survivors
	for _, r := range survivors {
		c := Candidate{Restaurant: r, Score: 1.0}
		for _, f := range factors {
			e := f(r, in)
			if e.Factor == "" { // 未知資料可保持 neutral，且不產生虛構 trace。
				continue
			}
			c.Score *= e.Mult
			c.Trace = append(c.Trace, e)
		}
		res.Kept = append(res.Kept, c)
	}
	normalize(res.Kept)
	return res
}

func normalize(kept []Candidate) {
	var sum float64
	for i := range kept {
		sum += kept[i].Score
	}
	if sum == 0 {
		return
	}
	for i := range kept {
		kept[i].Probability = kept[i].Score / sum
	}
}

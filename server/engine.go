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
	Kinds  []string // 全部命中的排除類別（dietary/budget/closed），供統計不受檢查順序污染
	Reason string   // 全部原因以「；」串接，含成員歸因
}

type EngineInput struct {
	Restaurants          []Restaurant
	Members              []Member
	Now                  time.Time
	CenterLat, CenterLng float64
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
	if price := PriceLevelMaxTWD[r.PriceLevel]; price > minBudget {
		addKind("budget")
		reasons = append(reasons, fmt.Sprintf("價位約 NT$%d，超過 %s 的預算上限 NT$%d", price, minName, minBudget))
	}
	if !r.Hours.IsOpenAt(now) {
		addKind("closed")
		reasons = append(reasons, "目前未營業")
	}
	return kinds, reasons
}

type factorFn func(r Restaurant, in EngineInput) TraceEntry

func prefFactor(r Restaurant, in EngineInput) TraceEntry {
	hits := 0
	for _, m := range in.Members {
		for _, c := range m.Cuisines {
			if hasTag(r.CuisineTags, c) {
				hits++
				break
			}
		}
	}
	ratio := float64(hits) / float64(len(in.Members))
	mult := PrefMultMin + (PrefMultMax-PrefMultMin)*ratio
	return TraceEntry{"preference", mult,
		fmt.Sprintf("%d/%d 位成員偏好命中", hits, len(in.Members))}
}

func distFactor(r Restaurant, in EngineInput) TraceEntry {
	dist := Haversine(in.CenterLat, in.CenterLng, r.Lat, r.Lng)
	var sumMult, sumMin float64
	for _, m := range in.Members {
		minutes := dist / TransportMetersPerMin[m.Transport]
		frac := (minutes - DistBestMin) / (DistWorstMin - DistBestMin)
		if frac < 0 {
			frac = 0
		}
		if frac > 1 {
			frac = 1
		}
		sumMult += DistMultBest + (DistMultWorst-DistMultBest)*frac
		sumMin += minutes
	}
	n := float64(len(in.Members))
	return TraceEntry{"distance", sumMult / n,
		fmt.Sprintf("平均交通約 %.0f 分鐘", sumMin/n)}
}

func closingFactor(r Restaurant, in EngineInput) TraceEntry {
	left := r.Hours.MinutesUntilClose(in.Now)
	if left >= 0 && left < ClosingSoonMinutes {
		return TraceEntry{"closing_soon", ClosingSoonMult,
			fmt.Sprintf("%d 分鐘後打烊", left)}
	}
	return TraceEntry{"closing_soon", 1.0, "營業時間充裕"}
}

var factors = []factorFn{prefFactor, distFactor, closingFactor}

func Evaluate(in EngineInput) EngineResult {
	var res EngineResult
	for _, r := range in.Restaurants {
		if kinds, reasons := hardExclude(r, in.Members, in.Now); len(kinds) > 0 {
			res.Excluded = append(res.Excluded, Excluded{r, kinds, strings.Join(reasons, "；")})
			continue
		}
		c := Candidate{Restaurant: r, Score: 1.0}
		for _, f := range factors {
			e := f(r, in)
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

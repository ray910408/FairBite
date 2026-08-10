package main

// 所有可調參數集中此檔（spec §5）

// PriceLevelUnknown 代表未知價位：不參與預算硬排除；使用者裁決 2026-08-10，取代原「補中間值 2」。
const PriceLevelUnknown = -1

var PriceLevelMaxTWD = map[int]int{0: 100, 1: 200, 2: 400, 3: 800, 4: 1600}

// 嚴格禁忌：餐廳必須具備正向認證 tag 才保留 — 負向推斷會錯誤放行
// （例：滷肉飯店沒有衝突 tag 但素食者不能吃），codex review #4
var DietaryRequires = map[string]string{
	"vegetarian": "vegetarian_friendly",
	"halal":      "halal_certified",
}

// 偏好型禁忌 → 衝突的餐廳 tag（負向排除；漏放行屬可接受誤差，ADR-0001）
var DietaryConflicts = map[string][]string{
	"no_beef": {"steak", "beef_noodle"},
	"no_pork": {"ramen", "dimsum"},
}

var DietaryLabels = map[string]string{
	"vegetarian": "素食", "no_beef": "不吃牛", "no_pork": "不吃豬", "halal": "清真",
}

var TransportMetersPerMin = map[string]float64{"walking": 75, "driving": 500, "transit": 200}

// 交通時間細化（P2）：起步 overhead（開車找車位、大眾運輸等車），單位分鐘
var TransportOverheadMin = map[string]float64{"walking": 0, "driving": 6, "transit": 8}

var TransportLabels = map[string]string{"walking": "步行", "driving": "開車", "transit": "大眾運輸"}

// 探索檔位 = 三個係數的 preset。D14 的 explore ×1.25 是曝光因素未上線前的近似，P3 起由新店/熟店係數承擔探索語意
var RecencyPenaltyScale = map[string]float64{"familiar": 0.5, "balanced": 1.0, "explore": 1.0}

// 曝光/新店（P3 spec §5）：房內 chosen_count 聚合高者輕降權；全員 recommended_count = 0 小幅加成
const (
	NewStoreBonusMult    = 1.1 // 沒被推薦過的「新出現店家」→ 探索價值加成（balanced 檔全額）
	ChosenPenaltyMult    = 0.9 // 人均中選次數達門檻的降權下限（balanced 檔全額；spec「輕降權」）
	ChosenPenaltyAtCount = 5   // 「人均」chosen 次數 ≥ 此值全額生效，以下線性內插
	//（eng review D21：除以人數，比照 recencyFactor 的 /len 先例，
	// 否則 5 人房吃一次就吃滿懲罰）
)

// 探索檔位完整語意（spec §5.4）：新店加成倍率 × 熟店降權強度 × 近期懲罰強度 的 preset。
// familiar 的新店加成與熟店降權都關閉（eng review D8：「常去的店優先」不該再拉低常去的店，
// 壟斷防線由近期懲罰 0.5 充當）
var NewStoreBonusScale = map[string]float64{"familiar": 0, "balanced": 1.0, "explore": 2.0}
var ChosenPenaltyScale = map[string]float64{"familiar": 0, "balanced": 1.0, "explore": 1.5}

const (
	PrefMultMin = 0.6
	PrefMultMax = 1.5

	DistMultBest  = 1.2
	DistMultWorst = 0.7
	DistBestMin   = 5.0  // ≤5 分鐘 → DistMultBest
	DistWorstMin  = 25.0 // ≥25 分鐘 → DistMultWorst

	ClosingSoonMinutes  = 60
	ClosingSoonMult     = 0.6
	VoteBoostPerUp      = 0.10 // 每張贊成票 +10%（spec §5 投票加成）
	VetoQuota           = 2    // 每人同房同時最多否決數（spec §4；D15 後唯一權威，UI 文案另有顯示用複本）
	RecencyFloorMult    = 0.3  // 全員 14 天內去過 → ×0.3
	RecencyFadingWeight = 0.5  // 15–30 天的成員減半計
	RecencyMinMult      = 0.1  // 懲罰下限；現行參數下不觸發，調參安全網

	RateLimitPerSec = 2  // 每使用者每秒請求數（spec §7 token bucket）
	RateLimitBurst  = 10 // P2 投票為高頻互動，burst 需覆蓋一輪快速操作
)

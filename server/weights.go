package main

import "time"

// 所有可調參數集中此檔（spec §5）

// PriceLevelUnknown 代表未知價位：不參與預算硬排除；使用者裁決 2026-08-10，取代原「補中間值 2」。
const PriceLevelUnknown = -1

var PriceLevelMaxTWD = map[int]int{0: 100, 1: 200, 2: 400, 3: 800, 4: 1600}

// 嚴格禁忌：餐廳必須具備正向認證 tag 才保留 — 負向推斷會錯誤放行
// （例：滷肉飯店沒有衝突 tag 但素食者不能吃），codex review #4
var DietaryRequires = map[string]string{
	"vegetarian": "vegetarian_friendly",
}

// 偏好型禁忌 → 衝突的餐廳 tag（負向排除；漏放行屬可接受誤差，ADR-0001）
var DietaryConflicts = map[string][]string{
	"no_beef": {"steak", "beef_noodle"},
	"no_pork": {"ramen", "dimsum"},
}

var DietaryLabels = map[string]string{
	"vegetarian": "素食", "no_beef": "不吃牛", "no_pork": "不吃豬",
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

// 天氣（P3 spec §5）：雨天走路方案降權。全場均勻的倍率會在正規化後抵銷，
// 因此懲罰必須隨步行時間放大才有意義；只影響步行成員。
const (
	RainThresholdMM     = 0.1  // 降水量 ≥ 此值視為雨天
	RainWalkFreeMin     = 5.0  // 步行 ≤ 5 分鐘不受雨天影響
	RainWalkWorstMin    = 20.0 // 步行 ≥ 20 分鐘受全額降權
	RainWalkPenaltyMult = 0.7
)

var (
	WeatherCacheTTL     = 15 * time.Minute // 投票 rescore 頻繁，不能每票打一次 API
	WeatherFailRetryTTL = time.Minute      // negative cache（D24/OV#21）：故障期間不重複硬等 5 秒
)

// 時段×菜系（P3 spec §5）：時段命中 tag 小幅加成。
// 硬規則（eng review D23）：新增 slot/tag 前必須先驗證 tag 確實由 provider 產生
// （places_google.go googleTypeTags 或 mockdata.go）——不做無依據的時段×菜系配對。
// 晚餐 slot 因無任何真實 tag 來源而不上（hotpot 只存在於 mock），待 tag 詞彙擴充再回歸。
const TimeSlotBoostMult = 1.15

var TimeSlotBoosts = map[string][]string{
	"morning": {"breakfast"}, // breakfast ← googleTypeTags["breakfast_restaurant"] ✓
}

// [起, 迄) 小時邊界；slot 區間不重疊（task3 review r1：可調參數集中 weights.go）
var TimeSlotHours = map[string][2]int{"morning": {6, 11}} // 06:00–10:59

var TimeSlotLabels = map[string]string{"morning": "早餐時段"}

// 滿足度 EMA 與成員公平（P3 spec §5）
const (
	EMAAlpha            = 0.3  // spec §5：α 起始 0.3
	EMASampleWindow     = 20   // 每人取最近 N 筆樣本折 EMA；更早的影響已被 α 衰減到可忽略
	FairnessBoostWeight = 2.0  // 滿足度最低成員在偏好因素中的權重（其他人 1.0）
	FairnessMinGap      = 0.15 // 最高最低 EMA 差距低於此值視為「大家一樣滿意」，不校正
)

const (
	PrefMultMin = 0.6
	PrefMultMax = 1.5

	DistMultBest  = 1.2
	DistMultWorst = 0.7
	DistBestMin   = 5.0  // ≤5 分鐘 → DistMultBest
	DistWorstMin  = 25.0 // ≥25 分鐘 → DistMultWorst

	// CenterDistGridM：「候選到圓心距離」的量化網格（公尺）。所有圓心衍生的訊號一律走它。
	// 0015 把 rooms.center_lat/center_lng 收成欄級 grant，但 weight_breakdown 對同房成員
	// 可讀（room_candidates 有 table-level SELECT grant + candidates_select policy），而
	// distFactor/rainFactor 的倍率都是該距離的單調確定性函數；成員的 transport（room_members
	// 有 table-level SELECT grant）與候選的 lat/lng（0005 restaurants_select）也都讀得到。
	// 全精度倍率 → 反推 dist → 三家以上候選三角定位出圓心 → 兩人房用 other = 2*center - own
	// 還原另一人的精確 GPS，欄級 grant 等於白鎖。
	//
	// 只量化 trace 不夠：probability 同樣公開（room_candidates.probability、HTTP 回應、
	// draws.probabilities），而它是 Score 的正規化，Score 又是各因素倍率的乘積。trace 裡
	// 其他因素（preference、closing_soon、recency…）本來就是精確值，除掉之後
	// probability_i / probability_j 就還原出距離倍率的精確比值，三家候選兩條方程式一樣解得出
	// 圓心——量化 trace 卻用全精度計分等於關前門留側窗。對策見 engine.go snapCenterDist：
	// 距離在因素內就先量化，計分、機率、trace 因此是同一個量化距離的函數，
	// 殘餘不確定性恆等於網格寬度，不會被任何公開出口細分。
	//
	// 代價：抽獎機率也走量化距離，相距一個網格以內的兩家候選距離權重相同。以下方常數換算，
	// 300 公尺（全員步行）對應距離倍率階距 0.10、範圍 1.2–0.7，最多影響單一候選權重約 ±0.05。
	// 這是軟性偏好權重不是硬性過濾，接受。硬性半徑過濾（freeze.go 重濾、provider fetch
	// envelope）仍用真實距離——那條不洩漏，候選集合本身就已經是公開的粗略旁通道。
	//
	// 網格寬度由實際常數推算，取倍率對距離最敏感的情境（全員步行，TransportMetersPerMin 最小）：
	//   distance：minutes = 0 + dist/75、frac = (minutes-5)/20、mult = 1.2 - 0.5*frac
	//             → d(mult)/d(dist) = -0.5/(20*75) = -1/3000 ≈ 3.33e-4 每公尺
	//   weather ：minutes = dist/75、frac = (minutes-5)/15、mult = 1 - 0.3*frac
	//             → d(mult)/d(dist) = -0.3/(15*75) = -1/3750 ≈ 2.67e-4 每公尺
	// transit（1/8000）與 driving（1/20000）敏感度更低，混合交通取平均後也介於兩者之間，
	// 殘餘不確定性只會比全員步行更大。
	// 300 公尺網格 ⇒ 最壞情況下 distance 倍率階距 0.10、weather 0.08，殘餘不確定性
	// = 網格寬度 = 300 公尺（單一候選）。
	CenterDistGridM = 300.0

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

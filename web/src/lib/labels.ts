import type { MemberRow, RestaurantRef, Room } from './types'

export const TRANSPORT_LABELS: Record<MemberRow['transport'], string> = {
  walking: '步行', driving: '開車', transit: '大眾運輸',
}

const BUDGET_TIER_LABELS = ['', '平價', '中等', '偏高', '高價']

export function budgetTierLabel(budgetMax: number) {
  if (budgetMax < 100 || budgetMax > 1600) return '未設定'
  if (budgetMax <= 200) return BUDGET_TIER_LABELS[1]
  if (budgetMax <= 400) return BUDGET_TIER_LABELS[2]
  if (budgetMax <= 800) return BUDGET_TIER_LABELS[3]
  return BUDGET_TIER_LABELS[4]
}

export const CUISINE_OPTIONS: [string, string][] = [
  ['taiwanese', '台式'], ['japanese', '日式'], ['korean', '韓式'],
  ['cantonese', '港式'], ['western', '西式'], ['fast_food', '速食'], ['indian', '印度'],
  ['hotpot', '火鍋'], ['seafood', '海鮮'], ['ramen', '拉麵'],
  ['dessert', '甜點'], ['light_meal', '輕食'], ['breakfast', '早午餐'],
]

export const CUISINE_LABEL = Object.fromEntries(CUISINE_OPTIONS)

// spec「已知 tag 才顯示」規則的單一真相點（足跡頁 summarize／清單 chips 與候選列共用）：
// 不在對照表的內部 tag（如 dimsum）不顯示；保輸入順序
export function knownCuisineLabels(tags: string[]): string[] {
  return tags.map(t => CUISINE_LABEL[t]).filter((l): l is string => Boolean(l))
}

// 候選列的店家資訊：挑店真正會看的評分、價位、菜系。評分 0／價位 -1 是 Google 沒給（weights.go PriceLevelUnknown）
export function restaurantFacts(r: RestaurantRef): string[] {
  const facts: string[] = []
  const rating = Number(r.rating ?? 0)
  if (rating > 0) facts.push(`★${rating.toFixed(1)}`)
  const price = BUDGET_TIER_LABELS[r.price_level ?? 0]
  if (price) facts.push(price)
  facts.push(...knownCuisineLabels(r.cuisine_tags ?? []).slice(0, 2))
  return facts
}

export const DIETARY_OPTIONS: [string, string][] = [
  ['vegetarian', '素食'],
]

export const DIETARY_LABEL = Object.fromEntries(DIETARY_OPTIONS)

export const EXPLORATION_OPTIONS: [Room['exploration'], string, string][] = [
  ['familiar', '熟悉', '常去的店優先：新店加成關閉，最近去過的降權減半'],
  ['balanced', '平均', '預設的平衡配置'],
  ['explore', '探索', '沒去過的店加成加倍、常中選的店降權，鼓勵換口味'],
]

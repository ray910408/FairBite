import { CUISINE_LABEL } from './labels'

// 足跡頁（spec 2026-08-14）資料塑形。查詢結果為 decided_at 倒序，
// 這裡的函式都以此為輸入前提。日期一律瀏覽器當地時間（決策 #8）。
export type FootprintRow = {
  id: string
  decided_at: string
  rating: number | null
  restaurants: { name: string; cuisine_tags: string[] } | null
}

export type FootprintSummary = {
  total: number                    // 全表符合數（查詢 count），可能大於撈回列數
  ratedCount: number
  avgRating: number | null         // 只算實評（決策 #6）；無實評為 null
  cuisineTop: [string, number][]   // [中文標籤, 次數] 前 5；未知內部 tag（如 dimsum）不計
}

// spec「已知 tag 才顯示」規則的單一真相點（summarize 與清單 chips 共用）：
// 不在對照表的內部 tag（如 dimsum）不顯示；保輸入順序
export function knownCuisineLabels(tags: string[]): string[] {
  return tags.map(t => CUISINE_LABEL[t]).filter((l): l is string => Boolean(l))
}

export function summarize(rows: FootprintRow[], total: number): FootprintSummary {
  const rated = rows.filter(r => r.rating !== null)
  const counts = new Map<string, number>()
  for (const r of rows) {
    for (const label of knownCuisineLabels(r.restaurants?.cuisine_tags ?? [])) {
      counts.set(label, (counts.get(label) ?? 0) + 1)
    }
  }
  return {
    total,
    ratedCount: rated.length,
    avgRating: rated.length
      ? rated.reduce((s, r) => s + (r.rating as number), 0) / rated.length
      : null,
    cuisineTop: [...counts].sort((a, b) => b[1] - a[1]).slice(0, 5),
  }
}

// 走勢資料（決策 #6 只畫實評）：取最近 limit 筆實評，反轉為時間正序
export function trendRatings(rows: FootprintRow[], limit = 30): number[] {
  return rows.filter(r => r.rating !== null).slice(0, limit).reverse()
    .map(r => r.rating as number)
}

export type MonthGroup = { label: string; rows: FootprintRow[] }

export function groupByMonth(rows: FootprintRow[]): MonthGroup[] {
  const groups: MonthGroup[] = []
  for (const r of rows) {
    const d = new Date(r.decided_at)
    const label = `${d.getFullYear()} 年 ${d.getMonth() + 1} 月`
    const last = groups[groups.length - 1]
    if (last && last.label === label) last.rows.push(r)
    else groups.push({ label, rows: [r] })
  }
  return groups
}

export function formatDay(iso: string): string {
  const d = new Date(iso)
  return `${d.getMonth() + 1}/${d.getDate()}`
}

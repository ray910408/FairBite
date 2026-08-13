// 用餐時間（spec §4）：抵達/開吃時刻，今日限定。「今日」以瀏覽器本地時區判定
// （client/APP_TZ 分歧為 spec 已接受的顯示層誤差；引擎端另有 max(now, T) 容錯）。
export function buildMealTimeISO(hhmm: string, now: Date = new Date()): { iso: string } | { error: string } {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return { error: '請輸入用餐時間' }
  const t = new Date(now)
  t.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (t.getTime() <= now.getTime()) return { error: '用餐時間必須晚於現在' }
  return { iso: t.toISOString() }
}

export function formatMealTime(iso: string | null | undefined): string {
  if (!iso) return '馬上出發'
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `今天 ${hh}:${mm}`
}

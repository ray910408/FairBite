// 用餐時間（spec §4）：抵達/開吃時刻，最遠到明天——不晚於現在的時刻視為明天同一時刻
// （22:35 設 19:30 = 明天 19:30）。「今天/明天」以瀏覽器本地時區判定
// （client/APP_TZ 分歧為 spec 已接受的顯示層誤差；引擎端另有 max(now, T) 容錯）。
export function buildMealTimeISO(hhmm: string, now: Date = new Date()): { iso: string } | { error: string } {
  const m = /^(\d{2}):(\d{2})$/.exec(hhmm)
  if (!m) return { error: '請輸入用餐時間' }
  const t = new Date(now)
  t.setHours(Number(m[1]), Number(m[2]), 0, 0)
  if (t.getTime() <= now.getTime()) {
    // 秋季回撥的重複時段 setHours 取較早那次；較晚那次還沒到就用它，不必滾到明天
    const shift = new Date(t.getTime() + 3 * 3600_000).getTimezoneOffset() - t.getTimezoneOffset()
    const later = new Date(t.getTime() + shift * 60_000)
    if (later.getTime() > now.getTime() && later.getHours() === t.getHours() && later.getMinutes() === t.getMinutes()) {
      return { iso: later.toISOString() }
    }
    t.setDate(t.getDate() + 1)
  }
  return { iso: t.toISOString() }
}

export function formatMealTime(iso: string | null | undefined, now: Date = new Date()): string {
  if (!iso) return '馬上出發'
  const d = new Date(iso)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  const tomorrow = new Date(now)
  tomorrow.setDate(now.getDate() + 1)
  if (d.toDateString() === now.toDateString()) return `今天 ${hh}:${mm}`
  if (d.toDateString() === tomorrow.toDateString()) return `明天 ${hh}:${mm}`
  return `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`
}

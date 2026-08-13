// 出發點（CONTEXT.md）：房主選定的搜尋圓心資料來源——Nominatim 地名搜尋與上次選點記憶。
// Nominatim 使用政策：送出制查詢（禁 autocomplete）、個人規模、瀏覽器自帶 Referer 識別。
export type DeparturePoint = { lat: number; lng: number; label: string }

let lastSearchAt = 0

// 測試用：模組層 throttle 狀態的唯一重置出口（fake timers 會汙染 lastSearchAt）
export function _resetSearchThrottleForTests() {
  lastSearchAt = 0
}

export async function searchPlaces(query: string): Promise<DeparturePoint[]> {
  // Nominatim 使用政策：絕對上限 1 req/s——送出制之外再加最小間隔保險
  const wait = lastSearchAt + 1000 - Date.now()
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  lastSearchAt = Date.now()
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q: query, format: 'jsonv2', limit: '5', 'accept-language': 'zh-TW', countrycodes: 'tw',
  })
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error('地點搜尋暫時無法使用，請稍後再試或改用地圖選點')
  const rows = (await resp.json()) as { lat: string; lon: string; display_name: string }[]
  return rows.map(r => ({
    lat: Number(r.lat), lng: Number(r.lon),
    label: r.display_name.split(',').slice(0, 2).map(s => s.trim()).join('，'),
  }))
}

export function loadLastDeparture(uid: string): DeparturePoint | null {
  if (!uid) return null
  try {
    const v = JSON.parse(localStorage.getItem(`last-departure:${uid}`) ?? 'null')
    return typeof v?.lat === 'number' && typeof v?.lng === 'number' && typeof v?.label === 'string' ? v : null
  } catch {
    return null
  }
}

export function saveLastDeparture(uid: string, p: DeparturePoint) {
  if (!uid) return
  try { localStorage.setItem(`last-departure:${uid}`, JSON.stringify(p)) } catch { /* 私密模式等寫入失敗可忽略 */ }
}

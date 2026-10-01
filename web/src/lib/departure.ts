// 出發點（CONTEXT.md）：房主選定的搜尋圓心資料來源——Nominatim 地名搜尋與上次選點記憶。
// Nominatim 使用政策：送出制查詢（禁 autocomplete）、個人規模、瀏覽器自帶 Referer 識別。
export type DeparturePoint = { lat: number; lng: number; label: string; context?: string }

let lastSearchAt = 0

// 測試用：模組層 throttle 狀態的唯一重置出口（fake timers 會汙染 lastSearchAt）
export function _resetSearchThrottleForTests() {
  lastSearchAt = 0
}

export async function searchPlaces(query: string): Promise<DeparturePoint[]> {
  // Nominatim 使用政策：絕對上限 1 req/s——送出制之外再加最小間隔保險
  const wait = Math.min(lastSearchAt + 1000 - Date.now(), 1000)
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  lastSearchAt = Date.now()
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q: query, format: 'jsonv2', limit: '5', 'accept-language': 'zh-TW', countrycodes: 'tw',
    addressdetails: '1',
  })
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error('地點搜尋暫時無法使用，請稍後再試或改用地圖選點')
  type Row = {
    lat: string; lon: string; name?: string; display_name: string
    address?: {
      road?: string; suburb?: string; city_district?: string
      town?: string; village?: string; city?: string; county?: string
    }
  }
  const rows = (await resp.json()) as Row[]
  // display_name 前段常是門牌/編號（QA ISSUE-005 的「台北車站，49」）：
  // 主標籤用 name，脈絡改由結構化 address 組裝，缺欄位就少一段
  return rows.map(r => {
    const label = r.name?.trim() || (r.display_name.split(',')[0] ?? '').trim()
    const a = r.address ?? {}
    const context = [a.road, a.city_district ?? a.suburb ?? a.town ?? a.village, a.city ?? a.county]
      .filter((s): s is string => !!s && s !== label).join('・')
    return { lat: Number(r.lat), lng: Number(r.lon), label, context: context || undefined }
  })
}

function readPoint(key: string): DeparturePoint | null {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? 'null')
    return typeof v?.lat === 'number' && typeof v?.lng === 'number' && typeof v?.label === 'string' ? v : null
  } catch {
    return null
  }
}

function writePoint(key: string, p: DeparturePoint) {
  try { localStorage.setItem(key, JSON.stringify(p)) } catch { /* 私密模式等寫入失敗可忽略 */ }
}

export function loadLastDeparture(uid: string): DeparturePoint | null {
  return uid ? readPoint(`last-departure:${uid}`) : null
}

export function saveLastDeparture(uid: string, p: DeparturePoint) {
  if (uid) writePoint(`last-departure:${uid}`, p)
}

// 房內讀不到圓心（types.ts：center_lat/lng 欄級 grant 只給 service role），地名也沒落庫——
// 只有選點的那台裝置記得。繼任房主或換裝置查不到就回 null，由 UI 改講「已設定」。
// ponytail: 每房一個 key 不清理，量級是個人建房次數；真的堆太多再按 created_at 掃
export function loadRoomDeparture(roomId: string): DeparturePoint | null {
  return readPoint(`room-departure:${roomId}`)
}

export function saveRoomDeparture(roomId: string, p: DeparturePoint) {
  writePoint(`room-departure:${roomId}`, p)
}

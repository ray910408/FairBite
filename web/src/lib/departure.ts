// 出發點（CONTEXT.md）：房主選定的搜尋圓心資料來源——Nominatim 地名搜尋與上次選點記憶。
// Nominatim 使用政策：送出制查詢（禁 autocomplete）、個人規模、瀏覽器自帶 Referer 識別。
export type DeparturePoint = { lat: number; lng: number; label: string; context?: string }

let lastSearchAt = 0

// 測試用：模組層 throttle 狀態的唯一重置出口（fake timers 會汙染 lastSearchAt）
export function _resetSearchThrottleForTests() {
  lastSearchAt = 0
}

// near：排序偏向的中心（現任出發點，沒有就地圖預設）。不用 countrycodes=tw 硬過濾——
// 它讓「東京車站」只撈到台灣的模糊命中、「銀座」只剩花蓮，出國的房主搜不到；
// viewbox（bounded 預設 0）只加權不排除，「中山」仍先出台北、外地名照樣找得到。
// 代價：偏向框外的台灣小地名可能輸給同名的國外大地點，補縣市名即可。
export async function searchPlaces(query: string, near: { lat: number; lng: number }): Promise<DeparturePoint[]> {
  // Nominatim 使用政策：絕對上限 1 req/s——送出制之外再加最小間隔保險
  const wait = Math.min(lastSearchAt + 1000 - Date.now(), 1000)
  if (wait > 0) await new Promise(resolve => setTimeout(resolve, wait))
  lastSearchAt = Date.now()
  const clamp = (v: number, max: number) => Math.max(-max, Math.min(max, v))
  // Leaflet 在 world copy 上點出的經度不折回（如 237.6），夾值後會變零寬框被 Nominatim 400
  const lng = Math.abs(near.lng) <= 180 ? near.lng : (((near.lng + 180) % 360) + 360) % 360 - 180
  // 圓心可能是房主精確位置（ADR-0005），送第三方前量化到 0.1°（約 11km）；±0.25° 的框仍罩得住原點
  const q = (v: number) => Math.round(v * 10) / 10
  const x = q(lng), y = q(near.lat)
  const d = 0.25 // 約 ±25km，涵蓋一個都會區
  const url = 'https://nominatim.openstreetmap.org/search?' + new URLSearchParams({
    q: query, format: 'jsonv2', limit: '5', 'accept-language': 'zh-TW', addressdetails: '1',
    viewbox: [clamp(x - d, 180), clamp(y + d, 90), clamp(x + d, 180), clamp(y - d, 90)].map(v => v.toFixed(2)).join(','),
  })
  const resp = await fetch(url, { signal: AbortSignal.timeout(5000), headers: { Accept: 'application/json' } })
  if (!resp.ok) throw new Error('地點搜尋暫時無法使用，請稍後再試或改用地圖選點')
  type Row = {
    lat: string; lon: string; name?: string; display_name: string
    address?: {
      road?: string; suburb?: string; city_district?: string
      town?: string; village?: string; city?: string; county?: string
      state?: string; province?: string; country?: string; country_code?: string
    }
  }
  const rows = (await resp.json()) as Row[]
  // display_name 前段常是門牌/編號（QA ISSUE-005 的「台北車站，49」）：
  // 主標籤用 name，脈絡改由結構化 address 組裝，缺欄位就少一段。
  // 台灣以外補州/省與國名：同一串結果可能混著台灣與國外的同名地點（如美國多個 Springfield）
  return rows.map(r => {
    const label = r.name?.trim() || (r.display_name.split(',')[0] ?? '').trim()
    const a = r.address ?? {}
    const abroad = a.country_code !== 'tw'
    const context = [a.road, a.city_district ?? a.suburb ?? a.town ?? a.village, a.city ?? a.county,
      abroad ? a.state ?? a.province : undefined, abroad ? a.country : undefined]
      .filter((s, i, all): s is string => !!s && s !== label && all.indexOf(s) === i).join('・')
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

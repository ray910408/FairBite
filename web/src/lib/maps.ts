import { isGoogleSourced } from './placesSource'
import type { MemberRow, RestaurantRef } from './types'

export function buildGoogleMapsPlaceUrl(
  name: string, lat: number, lng: number, placeId: string, source: string,
): string {
  const q = new URLSearchParams({
    api: '1',
    query: `${name} ${lat},${lng}`,
  })
  if (placeId && isGoogleSourced(source)) {
    q.set('query_place_id', placeId)
  }
  return `https://www.google.com/maps/search/?${q.toString()}`
}

export function buildMapsUrl(r: RestaurantRef, transport: MemberRow['transport']): string {
  // 非 Google 出身的 id 不是真 Google Place ID、店名也是假的，塞進去會讓導航行為不定 → 純座標導航。
  // Google 店家的 destination 放店名＋地址：Maps 目的地欄顯示的是這段文字，放座標就只看到座標
  const google = r.place_id && isGoogleSourced(r.source)
  const label = google ? [r.name, r.address].filter(Boolean).join(' ') : ''
  const q = new URLSearchParams({
    api: '1',
    destination: label || `${r.lat},${r.lng}`,
    travelmode: transport,
  })
  if (google) q.set('destination_place_id', r.place_id)
  return `https://www.google.com/maps/dir/?${q.toString()}`
}

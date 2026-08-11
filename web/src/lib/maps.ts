import { isGoogleSourced } from './placesSource'
import type { MemberRow } from './types'

export function buildMapsUrl(
  lat: number, lng: number, placeId: string, source: string,
  transport: MemberRow['transport'],
): string {
  const q = new URLSearchParams({
    api: '1',
    destination: `${lat},${lng}`,
    travelmode: transport,
  })
  // 非 Google 出身的 id 不是真 Google Place ID，塞進去會讓導航行為不定 → 純座標導航
  if (placeId && isGoogleSourced(source)) q.set('destination_place_id', placeId)
  return `https://www.google.com/maps/dir/?${q.toString()}`
}

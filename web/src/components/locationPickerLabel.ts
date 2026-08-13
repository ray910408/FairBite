export type LatLng = { lat: number; lng: number }

export function approxMeters(a: LatLng, b: LatLng) {
  const dLat = (a.lat - b.lat) * 111320
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(dLat, dLng)
}

export function mapSelectionLabel(currentLabel: string | null | undefined, anchor: LatLng | null, next: LatLng) {
  if (!currentLabel || !anchor) return '地圖上的位置'
  return approxMeters(anchor, next) <= 250 ? currentLabel : '地圖上的位置'
}

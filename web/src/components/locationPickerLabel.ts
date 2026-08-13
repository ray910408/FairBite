import type { DeparturePoint } from '../lib/departure'

export function approxMeters(a: { lat: number; lng: number }, b: { lat: number; lng: number }) {
  const dLat = (a.lat - b.lat) * 111320
  const dLng = (a.lng - b.lng) * 111320 * Math.cos((a.lat * Math.PI) / 180)
  return Math.hypot(dLat, dLng)
}

export function mapSelectionLabel(current: DeparturePoint | null, next: { lat: number; lng: number }) {
  return current && approxMeters(current, next) <= 250 ? current.label : '地圖上的位置'
}

export type Coordinates = { lat: number; lng: number }

export type GeolocationLike = Pick<Geolocation, 'getCurrentPosition'>

export function getPosition(geolocation: GeolocationLike | undefined): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    if (!geolocation) {
      reject(new Error('瀏覽器無法使用定位功能'))
      return
    }
    geolocation.getCurrentPosition(
      position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      () => reject(new Error('無法取得目前位置')),
      { timeout: 5000 },
    )
  })
}

export function parseCoordinates(latValue: string, lngValue: string): Coordinates | null {
  if (!latValue.trim() || !lngValue.trim()) return null
  const lat = Number(latValue)
  const lng = Number(lngValue)
  if (!Number.isFinite(lat) || !Number.isFinite(lng) || lat < -90 || lat > 90 || lng < -180 || lng > 180) {
    return null
  }
  return { lat, lng }
}

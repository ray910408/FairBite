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

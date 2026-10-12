export type Coordinates = { lat: number; lng: number }

export type GeolocationLike = Pick<Geolocation, 'getCurrentPosition'>

// 權限被拒是最常見的失敗，而且再按幾次都一樣：要講去哪裡打開，以及不靠定位的替代做法
export const GEO_DENIED = '定位權限被拒：請在瀏覽器的網站設定允許「位置」，或改用搜尋、點地圖選出發點'

export function getPosition(geolocation: GeolocationLike | undefined): Promise<Coordinates> {
  return new Promise((resolve, reject) => {
    if (!geolocation) {
      reject(new Error('瀏覽器無法使用定位功能'))
      return
    }
    geolocation.getCurrentPosition(
      position => resolve({ lat: position.coords.latitude, lng: position.coords.longitude }),
      // code 1＝PERMISSION_DENIED；逾時與訊號不良再試可能就好
      err => reject(new Error(err?.code === 1 ? GEO_DENIED : '無法取得目前位置，請再試一次或改用搜尋')),
      { timeout: 5000 },
    )
  })
}

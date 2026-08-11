import { describe, expect, it, vi } from 'vitest'
import { getPosition, parseCoordinates, type GeolocationLike } from './geolocation'

describe('getPosition', () => {
  it('定位不支援時拒絕，不得靜默回傳預設地點', async () => {
    await expect(getPosition(undefined)).rejects.toThrow('瀏覽器無法使用定位功能')
  })

  it('定位失敗時拒絕，不得靜默回傳預設地點', async () => {
    const geolocation: GeolocationLike = {
      getCurrentPosition: vi.fn((_success, error) => error?.({} as GeolocationPositionError)),
    }
    await expect(getPosition(geolocation)).rejects.toThrow('無法取得目前位置')
  })

  it('定位成功時回傳真實座標', async () => {
    const geolocation: GeolocationLike = {
      getCurrentPosition: vi.fn(success => success({
        coords: { latitude: 24.986571, longitude: 121.453549 },
      } as GeolocationPosition)),
    }
    await expect(getPosition(geolocation)).resolves.toEqual({ lat: 24.986571, lng: 121.453549 })
  })
})

describe('parseCoordinates', () => {
  it('接受有效的緯經度', () => {
    expect(parseCoordinates('24.986571', '121.453549')).toEqual({ lat: 24.986571, lng: 121.453549 })
  })

  it.each([
    ['', '121.5'],
    ['25', ''],
    ['91', '121.5'],
    ['25', '181'],
    ['not-a-number', '121.5'],
  ])('拒絕空值、非數字或超出範圍的座標：%s, %s', (lat, lng) => {
    expect(parseCoordinates(lat, lng)).toBeNull()
  })
})

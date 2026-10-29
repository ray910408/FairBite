import { describe, expect, it } from 'vitest'
import { buildGoogleMapsPlaceUrl, buildMapsUrl } from './maps'
import type { RestaurantRef } from './types'

describe('buildGoogleMapsPlaceUrl', () => {
  it('以店名與座標搜尋並帶入有效 Google Place ID', () => {
    const url = buildGoogleMapsPlaceUrl('A&B 餐廳', 25.05, 121.52, 'ChIJabc', 'google')
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=A%26B+%E9%A4%90%E5%BB%B3+25.05%2C121.52&query_place_id=ChIJabc')
  })
  it('缺少 ID 或非 Google 出身時只使用店名與座標 fallback', () => {
    expect(buildGoogleMapsPlaceUrl('餐廳', 25.05, 121.52, '', 'google')).not.toContain('query_place_id=')
    expect(buildGoogleMapsPlaceUrl('餐廳', 25.05, 121.52, 'ChIJabc', 'mock')).not.toContain('query_place_id=')
  })
  // 同 buildMapsUrl 的交叉案例：只看 source 欄，place_id 前綴 sniff 復辟時會紅
  it('source 為 google 時，mock- 前綴的 place_id 仍帶入', () => {
    expect(buildGoogleMapsPlaceUrl('餐廳', 25.05, 121.52, 'mock-008', 'google')).toContain('query_place_id=mock-008')
  })
})

describe('buildMapsUrl', () => {
  const ref = (over: Partial<RestaurantRef> = {}): RestaurantRef => ({
    name: 'A&B 餐廳', address: '台北市中山區南京東路二段1號', lat: 25.05, lng: 121.52,
    place_id: 'abc123', source: 'google', ...over,
  })
  const params = (url: string) => new URL(url).searchParams

  it('Google 店家：destination 是店名＋地址，帶 place_id 與 travelmode', () => {
    const url = buildMapsUrl(ref(), 'transit')
    expect(url).toContain('https://www.google.com/maps/dir/?api=1')
    expect(params(url).get('destination')).toBe('A&B 餐廳 台北市中山區南京東路二段1號')
    expect(params(url).get('destination_place_id')).toBe('abc123')
    expect(params(url).get('travelmode')).toBe('transit')
    expect(url).not.toContain('origin=')
  })
  it('Google 店家沒有地址時只放店名', () => {
    expect(params(buildMapsUrl(ref({ address: '' }), 'walking')).get('destination')).toBe('A&B 餐廳')
    expect(params(buildMapsUrl(ref({ address: undefined }), 'walking')).get('destination')).toBe('A&B 餐廳')
  })
  it('缺 place_id 時退回純座標', () => {
    const url = buildMapsUrl(ref({ place_id: '' }), 'walking')
    expect(params(url).get('destination')).toBe('25.05,121.52')
    expect(url).not.toContain('destination_place_id')
  })
  // 交叉案例：釘住判定只看 source 欄，place_id 前綴 sniff 復辟時這兩題會紅。
  it('source 為 mock 時，長得像真的 place_id 也不進 URL，店名也不用', () => {
    const url = buildMapsUrl(ref({ place_id: 'ChIJN1t_tDeuEmsRUsoyG83frY4', source: 'mock' }), 'walking')
    expect(url).not.toContain('destination_place_id')
    expect(params(url).get('destination')).toBe('25.05,121.52')
  })
  it('source 為 google 時，mock- 前綴的 place_id 仍進 URL', () => {
    const url = buildMapsUrl(ref({ place_id: 'mock-008' }), 'walking')
    expect(params(url).get('destination_place_id')).toBe('mock-008')
  })
})

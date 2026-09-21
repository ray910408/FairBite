import { describe, expect, it } from 'vitest'
import { buildGoogleMapsPlaceUrl, buildMapsUrl } from './maps'

describe('buildGoogleMapsPlaceUrl', () => {
  it('以店名與座標搜尋並帶入有效 Google Place ID', () => {
    const url = buildGoogleMapsPlaceUrl('A&B 餐廳', 25.05, 121.52, 'ChIJabc', 'google')
    expect(url).toBe('https://www.google.com/maps/search/?api=1&query=A%26B+%E9%A4%90%E5%BB%B3+25.05%2C121.52&query_place_id=ChIJabc')
  })
  it('缺少或使用 mock ID 時只使用店名與座標 fallback', () => {
    expect(buildGoogleMapsPlaceUrl('餐廳', 25.05, 121.52, '', 'google')).not.toContain('query_place_id=')
    expect(buildGoogleMapsPlaceUrl('餐廳', 25.05, 121.52, 'mock-008', 'google')).not.toContain('query_place_id=')
    expect(buildGoogleMapsPlaceUrl('餐廳', 25.05, 121.52, 'ChIJabc', 'mock')).not.toContain('query_place_id=')
  })
})

describe('buildMapsUrl', () => {
  it('組出正確的 dir URL 與 travelmode', () => {
    const url = buildMapsUrl(25.05, 121.52, 'abc123', 'google', 'transit')
    expect(url).toContain('https://www.google.com/maps/dir/?api=1')
    expect(url).toContain('destination=25.05%2C121.52')
    expect(url).toContain('destination_place_id=abc123')
    expect(url).toContain('travelmode=transit')
    expect(url).not.toContain('origin=')
  })
  it('mock 出身的 place_id 不進 URL（非真實 Google Place ID）', () => {
    const url = buildMapsUrl(25.05, 121.52, 'mock-008', 'mock', 'walking')
    expect(url).not.toContain('destination_place_id')
    expect(url).toContain('destination=25.05%2C121.52')
  })
  // 交叉案例：釘住判定只看 source 欄，place_id 前綴 sniff 復辟時這兩題會紅。
  it('source 為 mock 時，長得像真的 place_id 也不進 URL', () => {
    const url = buildMapsUrl(25.05, 121.52, 'ChIJN1t_tDeuEmsRUsoyG83frY4', 'mock', 'walking')
    expect(url).not.toContain('destination_place_id')
  })
  it('source 為 google 時，mock- 前綴的 place_id 仍進 URL', () => {
    const url = buildMapsUrl(25.05, 121.52, 'mock-008', 'google', 'walking')
    expect(url).toContain('destination_place_id=mock-008')
  })
})

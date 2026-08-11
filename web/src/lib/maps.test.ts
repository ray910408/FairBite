import { describe, expect, it } from 'vitest'
import { buildMapsUrl } from './maps'

describe('buildMapsUrl', () => {
  it('組出正確的 dir URL 與 travelmode', () => {
    const url = buildMapsUrl(25.05, 121.52, 'abc123', 'google', 'transit')
    expect(url).toContain('https://www.google.com/maps/dir/?api=1')
    expect(url).toContain('destination=25.05%2C121.52')
    expect(url).toContain('destination_place_id=abc123')
    expect(url).toContain('travelmode=transit')
  })
  it('mock 出身的 place_id 不進 URL（非真實 Google Place ID）', () => {
    const url = buildMapsUrl(25.05, 121.52, 'mock-008', 'mock', 'walking')
    expect(url).not.toContain('destination_place_id')
    expect(url).toContain('destination=25.05%2C121.52')
  })
})

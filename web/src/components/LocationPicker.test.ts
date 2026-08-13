import { describe, expect, it } from 'vitest'
import { mapSelectionLabel } from './locationPickerLabel'

const current = { lat: 25.0478, lng: 121.517, label: '台北車站' }

describe('mapSelectionLabel', () => {
  it('沒有現值或移動超過 250m 時改成地圖位置標籤', () => {
    expect(mapSelectionLabel(null, { lat: 25.0478, lng: 121.517 })).toBe('地圖上的位置')
    expect(mapSelectionLabel(current, { lat: 25.0678, lng: 121.517 })).toBe('地圖上的位置')
  })

  it('250m 內微調保留既有標籤', () => {
    expect(mapSelectionLabel(current, { lat: 25.0488, lng: 121.517 })).toBe('台北車站')
  })
})

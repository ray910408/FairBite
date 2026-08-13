import { describe, expect, it } from 'vitest'
import { mapSelectionLabel } from './locationPickerLabel'

const anchor = { lat: 25.0478, lng: 121.517 }

describe('mapSelectionLabel', () => {
  it('沒有錨點或移動超過 250m 時改成地圖位置標籤', () => {
    expect(mapSelectionLabel('台北車站', null, anchor)).toBe('地圖上的位置')
    expect(mapSelectionLabel('台北車站', anchor, { lat: 25.0678, lng: 121.517 })).toBe('地圖上的位置')
  })

  it('連續小步移動仍以標籤誕生點為錨', () => {
    const step = 200 / 111320
    const first = { lat: anchor.lat + step, lng: anchor.lng }
    const second = { lat: anchor.lat + 2 * step, lng: anchor.lng }
    const third = { lat: anchor.lat + 3 * step, lng: anchor.lng }

    expect(mapSelectionLabel('台北車站', anchor, first)).toBe('台北車站')
    expect(mapSelectionLabel('台北車站', anchor, second)).toBe('地圖上的位置')
    expect(mapSelectionLabel('台北車站', anchor, third)).toBe('地圖上的位置')
  })
})

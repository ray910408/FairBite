import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadLastDeparture, saveLastDeparture, searchPlaces } from './departure'

describe('searchPlaces', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('把 Nominatim jsonv2 結果映射成座標與精簡標籤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { lat: '25.0478', lon: '121.517', display_name: '台北車站, 忠孝西路一段, 中正區, 臺北市, 臺灣' },
    ]))))
    await expect(searchPlaces('台北車站')).resolves.toEqual([
      { lat: 25.0478, lng: 121.517, label: '台北車站，忠孝西路一段' },
    ])
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('nominatim.openstreetmap.org/search')
    expect(url).toContain('countrycodes=tw')
    expect(url).toContain('limit=5')
  })

  it('非 200 回應拋出可讀錯誤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(searchPlaces('x')).rejects.toThrow('地點搜尋暫時無法使用')
  })
})

describe('last departure localStorage', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('round-trip 與壞資料防衛', () => {
    const items = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    })
    saveLastDeparture({ lat: 25, lng: 121.5, label: '公司' })
    expect(loadLastDeparture()).toEqual({ lat: 25, lng: 121.5, label: '公司' })
    localStorage.setItem('last-departure', '{broken')
    expect(loadLastDeparture()).toBeNull()
  })
})

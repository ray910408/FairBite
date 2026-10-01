import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  _resetSearchThrottleForTests, loadLastDeparture, loadRoomDeparture, saveLastDeparture, saveRoomDeparture, searchPlaces,
} from './departure'

const TPE = { lat: 25.0478, lng: 121.517 }

describe('searchPlaces', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    _resetSearchThrottleForTests()
  })

  it('連續搜尋至少間隔一秒才送出第二個請求', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 13, 12, 0, 0))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))

    await searchPlaces('第一筆', TPE)
    const second = searchPlaces('第二筆', TPE)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('時鐘回跳時等待仍不超過一秒', async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(2026, 7, 13, 12, 0, 0))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))

    await searchPlaces('第一筆', TPE)
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0))
    const second = searchPlaces('第二筆', TPE)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(999)
    expect(fetch).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    await second
    expect(fetch).toHaveBeenCalledTimes(2)
  })

  it('用 name 當標籤、address 組成脈絡，門牌片段不再外露', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      {
        lat: '25.0478', lon: '121.517', name: '台北車站',
        display_name: '台北車站, 49, 忠孝西路一段, 黎明里, 中正區, 臺北市, 100, 臺灣',
        address: { road: '忠孝西路一段', city_district: '中正區', city: '臺北市', country: '臺灣', country_code: 'tw' },
      },
    ]))))
    await expect(searchPlaces('台北車站', TPE)).resolves.toEqual([
      { lat: 25.0478, lng: 121.517, label: '台北車站', context: '忠孝西路一段・中正區・臺北市' },
    ])
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
    expect(url.href).toContain('nominatim.openstreetmap.org/search')
    expect(url.searchParams.get('addressdetails')).toBe('1')
    expect(url.searchParams.get('limit')).toBe('5')
    // 台灣地名靠 viewbox 加權（出發點周邊 ±0.25°）而非 countrycodes 硬過濾；bounded 不送＝不排除框外。
    // 圓心先量化到 0.1°（25.0478,121.517 → 25.0,121.5），精確座標不外送
    expect(url.searchParams.get('viewbox')).toBe('121.25,25.25,121.75,24.75')
    expect(url.searchParams.has('countrycodes')).toBe(false)
    expect(url.searchParams.has('bounded')).toBe(false)
  })

  it('國外結果照樣回傳、由國名起頭；偏向跟著出國的出發點走', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      {
        lat: '35.658', lon: '139.7016', name: '渋谷',
        display_name: '渋谷, 明治通り, 渋谷, 澀谷區, 東京都, 150-0002, 日本',
        address: { road: '明治通り', city: '澀谷區', country: '日本', country_code: 'jp' },
      },
      {
        lat: '1.2834', lon: '103.8607', name: '濱海灣金沙', display_name: '濱海灣金沙, 新加坡',
        address: { city: '新加坡', country: '新加坡', country_code: 'sg' },
      },
      {
        lat: '39.7817', lon: '-89.6501', name: 'Springfield', display_name: 'Springfield, Sangamon County, Illinois, 美國',
        address: { city: 'Springfield', county: 'Sangamon County', state: 'Illinois', country: '美國', country_code: 'us' },
      },
    ]))))
    await expect(searchPlaces('Shibuya Station', { lat: 35.6812, lng: 139.7671 })).resolves.toEqual([
      { lat: 35.658, lng: 139.7016, label: '渋谷', context: '日本・澀谷區・明治通り' },
      // 城市國家的 city 與國名同名，只出現一次
      { lat: 1.2834, lng: 103.8607, label: '濱海灣金沙', context: '新加坡' },
      // 同名城市靠州/省區分
      { lat: 39.7817, lng: -89.6501, label: 'Springfield', context: '美國・Illinois' },
    ])
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
    expect(url.searchParams.get('viewbox')).toBe('139.55,35.95,140.05,35.45')
    expect(url.searchParams.has('countrycodes')).toBe(false)
  })

  it('偏向框貼近換日線時夾在合法經度內', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    await searchPlaces('Suva', { lat: -18.1, lng: 179.9 })
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
    const [x1, , x2] = url.searchParams.get('viewbox')!.split(',').map(Number)
    expect(x1).toBeCloseTo(179.65)
    expect(x2).toBe(180)
  })

  it('地圖 world copy 上未折回的經度先正規化，不送零寬框', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    await searchPlaces('Ferry Building', { lat: 37.77, lng: 237.6 })
    const url = new URL(String(vi.mocked(fetch).mock.calls[0][0]))
    const [x1, , x2] = url.searchParams.get('viewbox')!.split(',').map(Number)
    expect(x1).toBeCloseTo(-122.65)
    expect(x2).toBeCloseTo(-122.15)
  })

  it('name 缺席時退回 display_name 第一段，無 address 就不給脈絡', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { lat: '25', lon: '121.5', display_name: '公司, 某路, 某區' },
    ]))))
    await expect(searchPlaces('公司', TPE)).resolves.toEqual([
      { lat: 25, lng: 121.5, label: '公司', context: undefined },
    ])
  })

  it('非 200 回應拋出可讀錯誤', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('', { status: 503 })))
    await expect(searchPlaces('x', TPE)).rejects.toThrow('地點搜尋暫時無法使用')
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
    saveLastDeparture('u1', { lat: 25, lng: 121.5, label: '公司' })
    expect(loadLastDeparture('u1')).toEqual({ lat: 25, lng: 121.5, label: '公司' })
    localStorage.setItem('last-departure:u1', '{broken')
    expect(loadLastDeparture('u1')).toBeNull()
  })

  it('依帳號隔離，空 uid 不讀也不寫', () => {
    const items = new Map<string, string>()
    const setItem = vi.fn((key: string, value: string) => items.set(key, value))
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem,
    })
    saveLastDeparture('u1', { lat: 25, lng: 121.5, label: '公司' })
    expect(loadLastDeparture('u2')).toBeNull()
    expect(loadLastDeparture('')).toBeNull()
    saveLastDeparture('', { lat: 24, lng: 120, label: '不應寫入' })
    expect(setItem).toHaveBeenCalledTimes(1)
  })

  it('房間出發點依房間隔離，與上次選點互不覆寫', () => {
    const items = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => items.get(key) ?? null,
      setItem: (key: string, value: string) => items.set(key, value),
    })
    saveRoomDeparture('r1', { lat: 25, lng: 121.5, label: '台北車站' })
    saveLastDeparture('u1', { lat: 24, lng: 120, label: '公司' })
    expect(loadRoomDeparture('r1')).toEqual({ lat: 25, lng: 121.5, label: '台北車站' })
    expect(loadRoomDeparture('r2')).toBeNull()
  })
})

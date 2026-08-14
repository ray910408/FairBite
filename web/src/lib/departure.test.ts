import { afterEach, describe, expect, it, vi } from 'vitest'
import { _resetSearchThrottleForTests, loadLastDeparture, saveLastDeparture, searchPlaces } from './departure'

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

    await searchPlaces('第一筆')
    const second = searchPlaces('第二筆')
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

    await searchPlaces('第一筆')
    vi.setSystemTime(new Date(2026, 7, 13, 11, 0, 0))
    const second = searchPlaces('第二筆')
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
        address: { road: '忠孝西路一段', city_district: '中正區', city: '臺北市' },
      },
    ]))))
    await expect(searchPlaces('台北車站')).resolves.toEqual([
      { lat: 25.0478, lng: 121.517, label: '台北車站', context: '忠孝西路一段・中正區・臺北市' },
    ])
    const url = String(vi.mocked(fetch).mock.calls[0][0])
    expect(url).toContain('nominatim.openstreetmap.org/search')
    expect(url).toContain('countrycodes=tw')
    expect(url).toContain('addressdetails=1')
    expect(url).toContain('limit=5')
  })

  it('name 缺席時退回 display_name 第一段，無 address 就不給脈絡', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify([
      { lat: '25', lon: '121.5', display_name: '公司, 某路, 某區' },
    ]))))
    await expect(searchPlaces('公司')).resolves.toEqual([
      { lat: 25, lng: 121.5, label: '公司', context: undefined },
    ])
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
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { loadLastDeparture, saveLastDeparture, searchPlaces } from './departure'

describe('searchPlaces', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
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

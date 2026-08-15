import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}))

import { searchRoom } from './api'

const degradedWarning = '外部搜尋暫時失敗，本次使用 30 天內的快取資料'

describe('searchRoom', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } })
    vi.unstubAllGlobals()
  })

  it('422 全排除時保留 degraded warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'no_candidates',
      excluded_by: { budget: 2 },
      degraded: true,
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })))

    await expect(searchRoom('room-1')).resolves.toEqual({
      error: '找不到符合所有條件的餐廳。\n最主要原因：預算（排除 2 家）。\n請放寬條件後再試。',
      warning: degradedWarning,
    })
  })

  it('422 菜系排除時顯示菜系 label', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'no_candidates',
      excluded_by: { cuisine: 3 },
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })))

    await expect(searchRoom('room-1')).resolves.toEqual({
      error: '找不到符合所有條件的餐廳。\n最主要原因：菜系（排除 3 家）。\n請放寬條件後再試。',
      warning: null,
    })
  })

  it('422 無附近餐廳時保留 degraded warning', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'no_restaurants_in_range',
      message: '此位置附近沒有餐廳資料',
      degraded: true,
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })))

    await expect(searchRoom('room-2')).resolves.toEqual({
      error: '此位置附近沒有餐廳資料',
      warning: degradedWarning,
    })
  })
})

describe('leaveRooms', () => {
  const fetchStub = vi.fn()

  beforeEach(() => {
    vi.resetModules()
    mocks.getSession.mockReset().mockResolvedValue({ data: { session: { access_token: 'token' } } })
    fetchStub.mockReset()
    vi.stubGlobal('fetch', fetchStub)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('fetch 失敗時靜默 resolve，不向外 throw', async () => {
    fetchStub.mockRejectedValue(new Error('down'))
    const { leaveRooms } = await import('./api')
    await expect(leaveRooms()).resolves.toBeUndefined()
  })

  it('正常路徑打 POST /api/leave 且帶 5 秒 AbortSignal', async () => {
    fetchStub.mockResolvedValue(new Response('{}'))
    const timeoutSpy = vi.spyOn(AbortSignal, 'timeout')
    const { leaveRooms } = await import('./api')
    await leaveRooms()
    const [url, init] = fetchStub.mock.calls.at(-1)!
    expect(String(url)).toContain('/api/leave')
    expect((init as RequestInit).signal).toBeInstanceOf(AbortSignal)
    expect(timeoutSpy).toHaveBeenCalledWith(5000)
  })

  it('single-flight：飛行中連呼兩次只發一次 fetch（StrictMode 雙 effect）', async () => {
    let resolveFirst!: (response: Response) => void
    fetchStub
      .mockImplementationOnce(() => new Promise<Response>(resolve => { resolveFirst = resolve }))
      .mockResolvedValue(new Response('{}'))
    const { leaveRooms } = await import('./api')
    const p1 = leaveRooms()
    const p2 = leaveRooms()
    expect(p2).toBe(p1)
    await vi.waitFor(() => expect(fetchStub).toHaveBeenCalledTimes(1))
    resolveFirst(new Response('{}'))
    await p1
    await leaveRooms()
    expect(fetchStub).toHaveBeenCalledTimes(2)
  })
})

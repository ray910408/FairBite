import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }))

vi.mock('./supabase', () => ({
  supabase: { auth: { getSession: mocks.getSession } },
}))

import { editConditions, searchRoom } from './api'

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

  // 嚴格禁忌的定向檢索掛掉＝結果集不完整。這時「請放寬條件」與「請換地點」都是錯的
  // 建議，使用者照做也不會有結果——唯一有用的是重試。
  it('422 嚴格禁忌檢索失敗時改叫人重試，不叫人放寬條件', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'no_candidates',
      excluded_by: { dietary: 4 },
      unfulfilled_dietary_terms: ['vegetarian'],
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })))

    await expect(searchRoom('room-3')).resolves.toEqual({
      error: '「素食」的搜尋暫時失敗，這次的結果不完整，放寬條件不會有幫助。請稍後再試一次。',
      warning: null,
    })
  })

  it('422 no_restaurants_in_range 也吃 unfulfilled_dietary_terms', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'no_restaurants_in_range',
      message: '此位置附近沒有餐廳資料',
      unfulfilled_dietary_terms: ['vegetarian'],
      degraded: true,
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })))

    await expect(searchRoom('room-3')).resolves.toEqual({
      error: '「素食」的搜尋暫時失敗，這次的結果不完整，放寬條件不會有幫助。請稍後再試一次。',
      warning: degradedWarning,
    })
  })

  it('422 unfulfilled_dietary_terms 為空陣列時維持原本的放寬建議', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: 'no_candidates',
      excluded_by: { dietary: 4 },
      unfulfilled_dietary_terms: [],
    }), { status: 422, headers: { 'Content-Type': 'application/json' } })))

    await expect(searchRoom('room-3')).resolves.toEqual({
      error: '找不到符合所有條件的餐廳。\n最主要原因：飲食禁忌（排除 4 家）。\n請放寬條件後再試。',
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

describe('editConditions', () => {
  beforeEach(() => {
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } })
    vi.unstubAllGlobals()
  })

  it('透過共用 POST action 呼叫 endpoint，204 回傳 null', async () => {
    const fetchStub = vi.fn().mockResolvedValue(new Response(null, { status: 204 }))
    vi.stubGlobal('fetch', fetchStub)

    await expect(editConditions('room-1')).resolves.toBeNull()
    expect(fetchStub).toHaveBeenCalledWith('/api/rooms/room-1/edit-conditions', expect.objectContaining({
      method: 'POST',
      headers: expect.objectContaining({ Authorization: 'Bearer token' }),
    }))
  })

  it('保留 API error，無 JSON error 時用修改條件 fallback', async () => {
    vi.stubGlobal('fetch', vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: '房間狀態已變更' }), { status: 409 }))
      .mockResolvedValueOnce(new Response('down', { status: 500 })))

    await expect(editConditions('room-1')).resolves.toBe('房間狀態已變更')
    await expect(editConditions('room-1')).resolves.toBe('修改條件失敗（500）')
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

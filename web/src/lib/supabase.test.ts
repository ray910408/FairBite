import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ createClient: vi.fn() }))
vi.mock('@supabase/supabase-js', () => ({ createClient: mocks.createClient }))

const issuedAtFuture = () => new Response(
  JSON.stringify({ code: 'PGRST303', details: null, hint: null, message: 'JWT issued at future' }), { status: 401 })

// 掛在 createClient 的 global.fetch 上才算數：只測包裝函式本身，漏接線也會綠
async function clientFetch() {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'https://example.supabase.co')
  await import('./supabase')
  return mocks.createClient.mock.calls.at(-1)![2].global.fetch as typeof fetch
}

describe('supabase client fetch：PostgREST 時鐘落後（PGRST303 JWT issued at future）', () => {
  const net = vi.fn<typeof fetch>()
  beforeEach(() => {
    vi.useFakeTimers()
    net.mockReset()
    vi.stubGlobal('fetch', net)
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it('隔一秒原樣重送一次，回傳重送的結果', async () => {
    net.mockResolvedValueOnce(issuedAtFuture()).mockResolvedValueOnce(new Response('[]', { status: 200 }))
    const f = await clientFetch()
    const init = { method: 'POST', headers: { Authorization: 'Bearer fresh' }, body: '{}' }
    const res = f('https://example.supabase.co/rest/v1/rpc/get_my_default_prefs', init)
    await vi.advanceTimersByTimeAsync(999)
    expect(net).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect((await res).status).toBe(200)
    expect(net).toHaveBeenCalledTimes(2)
    expect(net.mock.calls[1]).toEqual(net.mock.calls[0])
  })

  it('只重送一次：重送仍被擋就把 401 交給呼叫端', async () => {
    net.mockResolvedValueOnce(issuedAtFuture()).mockResolvedValueOnce(issuedAtFuture())
    const f = await clientFetch()
    const res = f('https://example.supabase.co/rest/v1/room_members')
    await vi.advanceTimersByTimeAsync(5000)
    expect((await res).status).toBe(401)
    expect(net).toHaveBeenCalledTimes(2)
  })

  it.each([
    ['anon 沒權限', { code: '42501', message: 'permission denied for table room_members' }],
    ['token 真的過期', { code: 'PGRST303', message: 'JWT expired' }],
  ])('其他 401（%s）照常交給呼叫端，不重送', async (_, body) => {
    net.mockResolvedValueOnce(new Response(JSON.stringify(body), { status: 401 }))
    const f = await clientFetch()
    const res = await f('https://example.supabase.co/rest/v1/room_members')
    expect(res.status).toBe(401)
    expect(net).toHaveBeenCalledTimes(1)
  })
})

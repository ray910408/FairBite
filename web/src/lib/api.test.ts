import { beforeEach, describe, expect, it, vi } from 'vitest'

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

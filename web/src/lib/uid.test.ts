import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }))
vi.mock('./supabase', () => ({ supabase: { auth: { getSession: mocks.getSession } } }))

import { getUid } from './uid'

describe('getUid', () => {
  it('回傳 session 中的使用者 id', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: { user: { id: 'u1' } } } })
    await expect(getUid()).resolves.toBe('u1')
  })
  it('未登入回傳 null', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } })
    await expect(getUid()).resolves.toBeNull()
  })
})

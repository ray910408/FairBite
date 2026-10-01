import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 房籍查詢的成功路徑由三個呼叫端整條打過（HistoryPage / RoomPage 的 askLeave、
// HomePage 的 mount 攔截）；這裡只釘住它們共同押注的那件事——這個 promise 一定會 settle。
const mocks = vi.hoisted(() => ({ from: vi.fn(), getUid: vi.fn() }))

vi.mock('./supabase', () => ({ supabase: { from: mocks.from } }))
vi.mock('./uid', () => ({ getUid: mocks.getUid }))

import { fetchLeaveRooms, isStaleRoom } from './roomMembership'

const QUERY_TIMEOUT = 5000 // 與 roomMembership.ts 同值

describe('fetchLeaveRooms 逾時出口', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.getUid.mockReset().mockResolvedValue('me')
    mocks.from.mockReset()
  })
  afterEach(() => vi.useRealTimers())

  // 連線懸掛（不是失敗，是永不 settle）沒有逾時就沒有出口：三個呼叫端全都 await 這個
  // promise，HomePage 的 leavePending 會永遠停在 true，建房／加入／登出三顆一起永久
  // 禁用，使用者被鎖死在首頁——比幽靈房籍更糟。逾時走既有的「查詢失敗」路徑（null）。
  it('查詢永不 settle 時仍在 5 秒後回 null，不吊死呼叫端', async () => {
    mocks.from.mockReturnValue({ select: () => new Promise(() => {}) })

    let outcome: unknown = 'still-pending'
    const pending = fetchLeaveRooms().then(v => (outcome = v))

    await vi.advanceTimersByTimeAsync(QUERY_TIMEOUT - 1)
    expect(outcome).toBe('still-pending') // 放行的是逾時本身，不是別的東西提早 settle

    await vi.advanceTimersByTimeAsync(1)
    await pending
    expect(outcome).toBeNull() // → 呼叫端拿到 kind:'unknown' 的保守 dialog
  })

  it('查詢正常回來就清掉逾時計時器，不留懸掛的 timer', async () => {
    mocks.from.mockReturnValue({ select: () => Promise.resolve({ data: [], error: null }) })

    await expect(fetchLeaveRooms()).resolves.toEqual([])
    expect(vi.getTimerCount()).toBe(0)
  })

  it('查詢拋錯也清掉逾時計時器', async () => {
    mocks.from.mockReturnValue({ select: () => Promise.reject(new Error('offline')) })

    await expect(fetchLeaveRooms()).resolves.toBeNull()
    expect(vi.getTimerCount()).toBe(0)
  })
})

// 殘留房（ADR-0007 2026-10-01 修訂）：判斷錯向「不是殘留」只會多問一次，錯向「是」會靜默退掉
// 進行中的房——所以邊界與解析失敗都必須落在 false
describe('isStaleRoom', () => {
  const now = Date.parse('2026-10-01T12:00:00Z')
  const HOUR = 60 * 60 * 1000

  it('沒設用餐時間就以建房時間起算，超過 12 小時才算殘留', () => {
    expect(isStaleRoom(new Date(now - 12 * HOUR).toISOString(), null, now)).toBe(false)
    expect(isStaleRoom(new Date(now - 12 * HOUR - 1).toISOString(), null, now)).toBe(true)
  })

  it('有用餐時間以它為準：昨晚建的明天的飯不算殘留', () => {
    const created = new Date(now - 30 * HOUR).toISOString()
    expect(isStaleRoom(created, new Date(now + HOUR).toISOString(), now)).toBe(false)
    expect(isStaleRoom(created, new Date(now - 13 * HOUR).toISOString(), now)).toBe(true)
  })

  it('時間解析失敗不算殘留（照舊問）', () => {
    expect(isStaleRoom('not-a-date', null, now)).toBe(false)
  })
})

it('fetchLeaveRooms 帶回每間房的殘留判定', async () => {
  mocks.getUid.mockReset().mockResolvedValue('me')
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000).toISOString()
  mocks.from.mockReset().mockReturnValue({
    select: (cols: string) => {
      expect(cols).toContain('created_at')
      expect(cols).toContain('meal_time')
      return Promise.resolve({ data: [
        { room_id: 'r1', rooms: { code: 'A', status: 'candidates', host_id: 'me', created_at: old, meal_time: null } },
        { room_id: 'r2', rooms: { code: 'B', status: 'lobby', host_id: 'x', created_at: new Date().toISOString(), meal_time: null } },
      ], error: null })
    },
  })
  const rooms = await fetchLeaveRooms()
  expect(rooms?.map(r => [r.id, r.stale])).toEqual([['r1', true], ['r2', false]])
})

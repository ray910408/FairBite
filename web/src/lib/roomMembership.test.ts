import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 房籍查詢的成功路徑由三個呼叫端整條打過（HistoryPage / RoomPage 的 askLeave、
// HomePage 的 mount 攔截）；這裡只釘住它們共同押注的那件事——這個 promise 一定會 settle。
const mocks = vi.hoisted(() => ({ from: vi.fn(), getUid: vi.fn() }))

vi.mock('./supabase', () => ({ supabase: { from: mocks.from } }))
vi.mock('./uid', () => ({ getUid: mocks.getUid }))

import { fetchLeaveRooms } from './roomMembership'

const QUERY_TIMEOUT = 5000 // 與 roomMembership.ts 同值；量級比照 api.ts 的 leaveRooms

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

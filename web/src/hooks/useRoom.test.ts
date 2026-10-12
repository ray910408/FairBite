import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room } from '../lib/types'
import { useRoom } from './useRoom'

const mocks = vi.hoisted(() => ({
  room: null as Room | null,
  stateIndex: 0,
  setters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as Array<() => void | (() => void)>,
  from: vi.fn(),
  gates: [] as Promise<void>[],
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = mocks.stateIndex++
      const setter = vi.fn()
      mocks.setters[index] = setter
      return [index === 0 ? mocks.room : initial, setter]
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useCallback: (fn: unknown) => fn,
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
  }
})

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: mocks.from,
    channel: vi.fn(),
    removeChannel: vi.fn(),
  },
}))
vi.mock('../lib/uid', () => ({ getUid: vi.fn() }))

function query(table: string) {
  const batch = Math.floor((mocks.from.mock.calls.length - 1) / 8)
  const gate = mocks.gates[batch] ?? Promise.resolve()
  const result = gate.then(() => ({ data: table === 'rooms' ? mocks.room : [], error: null }))
  if (table === 'rooms') return { select: () => ({ eq: () => ({ single: () => result }) }) }
  if (table === 'room_candidates') {
    return { select: () => ({ eq: () => ({ order: () => result }) }) }
  }
  if (table === 'draws') return { select: () => ({ eq: () => ({
    order: () => ({ limit: () => ({ maybeSingle: () => result }) }),
  }) }) }
  return { select: () => ({ eq: () => result }) }
}

function room(status: Room['status']): Room {
  return {
    id: 'room-1', code: 'ABC123', host_id: 'host-1', status,
    exploration: 'balanced', meal_time: null, cuisine_filter: false, draw_version: 0, search_version: 0,
  }
}

function deferred() {
  let resolve!: () => void
  const promise = new Promise<void>(r => { resolve = r })
  return { promise, resolve }
}

describe('useRoom lobby Realtime fallback', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.stateIndex = 0
    mocks.effects = []
    mocks.gates = []
    mocks.from.mockReset().mockImplementation(query)
  })

  afterEach(() => vi.useRealTimers())

  function RoomHarness(status: Room['status']) {
    mocks.room = room(status)
    const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
    const clearTimeoutSpy = vi.spyOn(globalThis, 'clearTimeout')
    useRoom('room-1')
    return { setTimeoutSpy, clearTimeoutSpy }
  }

  it('lobby 單飛 refetch 完成後才排下一輪，in-flight cleanup 不重排', async () => {
    const first = deferred()
    const second = deferred()
    mocks.gates = [first.promise, second.promise]
    const { setTimeoutSpy, clearTimeoutSpy } = RoomHarness('lobby')
    expect(mocks.effects).toHaveLength(2)
    const cleanup = mocks.effects[1]?.()
    expect(setTimeoutSpy).toHaveBeenCalledWith(expect.any(Function), 5_000)

    await vi.advanceTimersByTimeAsync(5_000)
    expect(mocks.from).toHaveBeenCalledWith('rooms')
    expect(mocks.from).toHaveBeenCalledWith('room_members')
    expect(mocks.from).toHaveBeenCalledWith('shortlist_votes')
    expect(mocks.from).toHaveBeenCalledWith('shortlist_picks')
    expect(mocks.from).toHaveBeenCalledTimes(8)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.from).toHaveBeenCalledTimes(8)

    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(mocks.from).toHaveBeenCalledTimes(8)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.from).toHaveBeenCalledTimes(16)

    expect(cleanup).toBeTypeOf('function')
    ;(cleanup as () => void)()
    expect(clearTimeoutSpy).toHaveBeenCalled()
    second.resolve()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.from).toHaveBeenCalledTimes(16)
  })

  it('非 lobby 不建立 fallback timer', async () => {
    const { setTimeoutSpy } = RoomHarness('voting')
    expect(mocks.effects).toHaveLength(2)
    expect(mocks.effects[1]?.()).toBeUndefined()
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })
})

describe('useRoom refetch 房間消失', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.setters = []
    mocks.effects = []
    mocks.gates = []
  })

  function RefetchHarness(result: { data: Room | null; error: unknown }) {
    mocks.room = room('lobby')
    mocks.from.mockReset().mockImplementation((table: string) => table === 'rooms'
      ? { select: () => ({ eq: () => ({ single: async () => result }) }) }
      : query(table))
    return useRoom('room-1').refetch()
  }

  it('查無列（房間已刪）清掉舊 room，頁面才會顯示找不到房間', async () => {
    await RefetchHarness({ data: null, error: { code: 'PGRST116' } })
    expect(mocks.setters[0]).toHaveBeenCalledWith(null)
  })

  it('暫時性錯誤保留舊 room（只亮 loadError）', async () => {
    await RefetchHarness({ data: null, error: { code: '57014' } })
    expect(mocks.setters[0]).not.toHaveBeenCalled()
  })
})

// 動作成功後 await refetch() 才解鎖按鈕：Realtime 剛好觸發新的一輪時，舊輪若提早 resolve，
// 按鈕會在新資料寫入前就解鎖，按下去伺服器回「房間狀態已變更」
describe('useRoom refetch 被新一輪取代', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.setters = []
    mocks.effects = []
    mocks.gates = []
  })

  it('舊輪等到新一輪把資料寫進 state 才 resolve', async () => {
    const first = deferred()
    const second = deferred()
    mocks.gates = [first.promise, second.promise]
    mocks.room = room('voting')
    mocks.from.mockReset().mockImplementation(query)
    const { refetch } = useRoom('room-1')
    let setRoomCallsWhenADone: number | undefined
    const a = refetch().then(() => { setRoomCallsWhenADone = mocks.setters[0].mock.calls.length })
    const b = refetch()

    first.resolve()
    await new Promise(r => setTimeout(r, 0))
    expect(setRoomCallsWhenADone).toBeUndefined() // A 的結果作廢，但不能先 resolve
    expect(mocks.setters[0]).not.toHaveBeenCalled()

    second.resolve()
    await Promise.all([a, b])
    expect(mocks.setters[0]).toHaveBeenCalledExactlyOnceWith(mocks.room)
    expect(setRoomCallsWhenADone).toBe(1)
  })
})

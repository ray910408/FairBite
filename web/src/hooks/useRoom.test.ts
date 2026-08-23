import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Room } from '../lib/types'
import { useRoom } from './useRoom'

const mocks = vi.hoisted(() => ({
  room: null as Room | null,
  stateIndex: 0,
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
      return [index === 0 ? mocks.room : initial, vi.fn()]
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
  const batch = Math.floor((mocks.from.mock.calls.length - 1) / 5)
  const gate = mocks.gates[batch] ?? Promise.resolve()
  const result = gate.then(() => ({ data: table === 'rooms' ? mocks.room : [], error: null }))
  if (table === 'rooms') return { select: () => ({ eq: () => ({ single: () => result }) }) }
  if (table === 'room_candidates') {
    return { select: () => ({ eq: () => ({ order: () => result }) }) }
  }
  if (table === 'draws') return { select: () => ({ eq: () => ({ maybeSingle: () => result }) }) }
  return { select: () => ({ eq: () => result }) }
}

function room(status: Room['status']): Room {
  return {
    id: 'room-1', code: 'ABC123', host_id: 'host-1', status,
    exploration: 'balanced', meal_time: null, cuisine_filter: false,
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
    expect(mocks.from).toHaveBeenCalledTimes(5)

    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.from).toHaveBeenCalledTimes(5)

    first.resolve()
    await vi.advanceTimersByTimeAsync(0)
    await vi.advanceTimersByTimeAsync(4_999)
    expect(mocks.from).toHaveBeenCalledTimes(5)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.from).toHaveBeenCalledTimes(10)

    expect(cleanup).toBeTypeOf('function')
    ;(cleanup as () => void)()
    expect(clearTimeoutSpy).toHaveBeenCalled()
    second.resolve()
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.from).toHaveBeenCalledTimes(10)
  })

  it('非 lobby 不建立 fallback timer', async () => {
    const { setTimeoutSpy } = RoomHarness('voting')
    expect(mocks.effects).toHaveLength(2)
    expect(mocks.effects[1]?.()).toBeUndefined()
    expect(setTimeoutSpy).not.toHaveBeenCalled()
  })
})

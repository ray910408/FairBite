import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { CandidateRow } from '../lib/types'

const hooks = vi.hoisted(() => ({
  index: 0,
  refs: [] as Array<{ current: unknown }>,
  deps: [] as Array<unknown[] | undefined>,
  cleanups: [] as Array<(() => void) | undefined>,
  pending: [] as Array<{ index: number; effect: () => void | (() => void) }>,
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useMemo: (factory: () => unknown) => factory(),
    useState: (initial: unknown) => [initial, vi.fn()],
    useRef: (initial: unknown) => {
      const index = hooks.index++
      return hooks.refs[index] ??= { current: initial }
    },
    useEffect: (effect: () => void | (() => void), deps: unknown[]) => {
      const index = hooks.index++
      const previous = hooks.deps[index]
      if (!previous || deps.some((value, i) => !Object.is(value, previous[i]))) {
        hooks.cleanups[index]?.()
        hooks.pending.push({ index, effect })
      }
      hooks.deps[index] = deps
    },
  }
})

const candidate: CandidateRow = {
  room_id: 'room-1', restaurant_id: 'r1', status: 'kept', probability: 1,
  weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
  restaurants: { name: '店家', lat: 25, lng: 121, place_id: 'p1', source: 'google' },
}

async function renderWheel(rows: CandidateRow[], onDone: () => void) {
  hooks.index = 0
  hooks.pending = []
  const { default: Wheel } = await import('./Wheel')
  Wheel({ rows, winnerId: 'r1', onDone })
  hooks.pending.splice(0).forEach(({ index, effect }) => {
    hooks.cleanups[index] = effect() || undefined
  })
}

beforeEach(() => {
  vi.useFakeTimers()
  hooks.index = 0
  hooks.refs = []
  hooks.deps = []
  hooks.cleanups = []
  hooks.pending = []
})

afterEach(() => {
  hooks.cleanups.forEach(cleanup => cleanup?.())
  vi.useRealTimers()
})

it('候選查詢恢復並補回 winner 時呼叫 onDone', async () => {
  const onDone = vi.fn()

  await renderWheel([], onDone)
  await vi.advanceTimersByTimeAsync(5000)
  expect(onDone).not.toHaveBeenCalled()

  await renderWheel([candidate], onDone)
  await vi.advanceTimersByTimeAsync(5000)
  expect(onDone).toHaveBeenCalledOnce()
})

it('winner 仍存在的一般 rows refetch 不重設轉盤 timer', async () => {
  const onDone = vi.fn()

  await renderWheel([candidate], onDone)
  await vi.advanceTimersByTimeAsync(2000)
  await renderWheel([{ ...candidate }], onDone)
  await vi.advanceTimersByTimeAsync(2199)
  expect(onDone).not.toHaveBeenCalled()

  await vi.advanceTimersByTimeAsync(1)
  expect(onDone).toHaveBeenCalledOnce()
})

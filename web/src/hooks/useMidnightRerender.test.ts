import { afterEach, expect, it, vi } from 'vitest'
import { useMidnightRerender } from './useMidnightRerender'

const mocks = vi.hoisted(() => ({
  effect: undefined as undefined | (() => void | (() => void)),
  setTick: vi.fn(),
}))

vi.mock('react', () => ({
  useState: (initial: unknown) => [initial, mocks.setTick],
  useEffect: (effect: () => void | (() => void)) => { mocks.effect = effect },
}))

afterEach(() => vi.useRealTimers())

it('跨過本地午夜才觸發重畫', () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 0))
  useMidnightRerender()
  mocks.effect?.()
  vi.advanceTimersByTime(59_000)
  expect(mocks.setTick).not.toHaveBeenCalled()
  vi.advanceTimersByTime(2_000)
  expect(mocks.setTick).toHaveBeenCalledOnce()
})

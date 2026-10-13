// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import '../test/dom'
import { useMidnightRerender } from './useMidnightRerender'

// 行為測試：真的 React hooks，數元件實際重畫幾次，不看 hook 內部的 setter。
// 時間用本地時間建構，hook 也是算本地午夜，任何時區都是「午夜前 60 秒」。

async function advance(ms: number) {
  await act(() => vi.advanceTimersByTimeAsync(ms))
}

it('跨過本地午夜才觸發重畫，之後排下一個午夜', async () => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date(2026, 8, 30, 23, 59, 0))
  let renders = 0
  renderHook(() => {
    renders++
    useMidnightRerender()
  })
  expect(renders).toBe(1)
  await advance(59_000)
  expect(renders).toBe(1)
  await advance(2_000)
  expect(renders).toBe(2)
  // 下一個午夜在 24 小時後（遇到日光節約是 23 或 25 小時）；25 小時內只會再重畫一次
  await advance(25 * 3_600_000)
  expect(renders).toBe(3)
})

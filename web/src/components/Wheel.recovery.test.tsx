// @vitest-environment jsdom
import { act, render, screen } from '@testing-library/react'
import { beforeEach, expect, it, vi } from 'vitest'
import type { CandidateRow } from '../lib/types'
import '../test/dom'
import Wheel from './Wheel'

// 行為測試：真的 React effect 與計時器（fake timers）；轉盤畫的是 SVG，jsdom 不需要 canvas 替身。
// ../test/dom 的 matchMedia 替身回 false（沒有減少動態偏好）：轉完是 4000 + 200 ms。

const candidate: CandidateRow = {
  room_id: 'room-1', restaurant_id: 'r1', status: 'kept', probability: 1,
  weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
  restaurants: { name: '店家', lat: 25, lng: 121, place_id: 'p1', source: 'google' },
}

const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms))

beforeEach(() => { vi.useFakeTimers() })

it('候選查詢恢復並補回 winner 時呼叫 onDone', async () => {
  const onDone = vi.fn()

  // 候選查詢失敗、清單是空的：winner 不在轉盤上，不能轉也不能結束
  const view = render(<Wheel rows={[]} winnerId="r1" onDone={onDone} />)
  await advance(5000)
  expect(onDone).not.toHaveBeenCalled()

  view.rerender(<Wheel rows={[candidate]} winnerId="r1" onDone={onDone} />)
  expect(screen.getByText('店家')).toBeTruthy()
  await advance(5000)
  expect(onDone).toHaveBeenCalledOnce()
})

it('winner 仍存在的一般 rows refetch 不重設轉盤 timer', async () => {
  const onDone = vi.fn()

  const view = render(<Wheel rows={[candidate]} winnerId="r1" onDone={onDone} />)
  await advance(2000)
  // Realtime refetch：新陣列、新物件，winner 還在
  view.rerender(<Wheel rows={[{ ...candidate }]} winnerId="r1" onDone={onDone} />)
  await advance(2199)
  expect(onDone).not.toHaveBeenCalled()

  await advance(1)
  expect(onDone).toHaveBeenCalledOnce()
})

// DrawPanel 以 draw.version 當 key：重轉出新版本時舊轉盤卸載，舊計時器不得把新的一輪提早結束
it('轉到一半卸載就不再呼叫 onDone', async () => {
  const onDone = vi.fn()

  const view = render(<Wheel rows={[candidate]} winnerId="r1" onDone={onDone} />)
  await advance(2000)
  view.unmount()
  await advance(5000)
  expect(onDone).not.toHaveBeenCalled()
})

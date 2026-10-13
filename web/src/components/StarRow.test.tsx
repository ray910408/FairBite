// @vitest-environment jsdom
import { act, fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, settle } from '../test/dom'
import StarRow from './StarRow'

// 行為測試：真的 React hooks 跑在 jsdom 上，只 mock lib/supabase（評分寫入）。
// 斷言只看畫面（aria-pressed／disabled／星星實心與否）與送出去的寫入參數。

type WriteResult = { error: { message: string } | null; count: number | null }

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from } }))

beforeEach(() => {
  mocks.is.mockReset().mockResolvedValue({ error: null, count: 1 })
  mocks.eq.mockReset().mockReturnValue({ is: mocks.is })
  mocks.update.mockReset().mockReturnValue({ eq: mocks.eq })
  mocks.from.mockReset().mockReturnValue({ update: mocks.update })
})

const star = (n: number) => screen.getByRole<HTMLButtonElement>('button', { name: `${n} 顆星` })
const submit = () => screen.getByRole<HTMLButtonElement>('button', { name: '送出評分' })
const stars = () => [1, 2, 3, 4, 5].map(star)
// 實心＝svg fill 是 currentColor（空心是 none）；品牌色在按鈕的 text-brand
const filled = () => stars().map(b => b.querySelector('svg')!.getAttribute('fill') === 'currentColor')
const brand = () => stars().map(b => b.classList.contains('text-brand'))

describe('StarRow 評分寫入防線', () => {
  it('點星只選不寫；沒選之前送出鈕 disabled', () => {
    render(<StarRow historyId="h-1" onRated={vi.fn()} />)
    expect(submit().disabled).toBe(true)

    fireEvent.click(star(3))
    expect(star(3).getAttribute('aria-pressed')).toBe('true')
    expect(stars().filter(b => b.getAttribute('aria-pressed') === 'true')).toHaveLength(1)
    expect(submit().disabled).toBe(false)
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('送出時鎖定 id 且僅寫入未評分列', async () => {
    const onRated = vi.fn()
    render(<StarRow historyId="h-1" onRated={onRated} />)
    fireEvent.click(star(3))
    fireEvent.click(submit())
    await settle()

    expect(mocks.from).toHaveBeenCalledWith('dining_history')
    expect(mocks.update).toHaveBeenCalledWith({ rating: 3 }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('id', 'h-1')
    expect(mocks.is).toHaveBeenCalledWith('rating', null)
    expect(onRated).toHaveBeenCalledWith(3)
  })

  // 預覽只是亮燈：游標或焦點還停在別顆星上時送出，寫入的是點選的那顆
  it('選 3 顆後滑鼠停在第 5 顆時送出，寫入的仍是 3', async () => {
    const onRated = vi.fn()
    render(<StarRow historyId="h-1" onRated={onRated} />)
    fireEvent.click(star(3))
    fireEvent.mouseEnter(star(5))
    fireEvent.click(submit())
    await settle()

    expect(mocks.update).toHaveBeenCalledWith({ rating: 3 }, { count: 'exact' })
    expect(onRated).toHaveBeenCalledWith(3)
  })

  // RLS 擋下或已評過時 204 無 error：count 0 也要當失敗，鎖要解開讓人能重試
  it('count 0（已評過）時顯示錯誤、解除 busy 且不觸發 onRated', async () => {
    const write = deferred<WriteResult>()
    mocks.is.mockReturnValue(write.promise)
    const onRated = vi.fn()
    render(<StarRow historyId="h-1" onRated={onRated} />)
    fireEvent.click(star(3))
    fireEvent.click(submit())
    await settle()
    // 寫入中：星星與送出都鎖住
    expect(submit().disabled).toBe(true)
    expect(submit().getAttribute('aria-busy')).toBe('true')
    expect(stars().every(b => b.disabled)).toBe(true)

    await act(async () => write.resolve({ error: null, count: 0 }))
    expect(screen.getByRole('alert').textContent).toBe('評分未儲存：這筆可能已評過，請重新整理')
    expect(submit().disabled).toBe(false)
    expect(submit().getAttribute('aria-busy')).toBe('false')
    expect(stars().every(b => !b.disabled)).toBe(true)
    expect(onRated).not.toHaveBeenCalled()
  })
})

describe('StarRow 累計高亮預覽', () => {
  it('hover／focus 第 3 顆時 1..3 亮成品牌色實心，4..5 維持空心', () => {
    render(<StarRow historyId="h-1" onRated={vi.fn()} />)
    fireEvent.mouseEnter(star(3))
    expect(filled()).toEqual([true, true, true, false, false])
    expect(brand()).toEqual([true, true, true, false, false])
  })

  it('選了 4 顆、沒有 hover 時 1..4 維持亮起，送出鈕可按', () => {
    render(<StarRow historyId="h-1" onRated={vi.fn()} />)
    fireEvent.mouseEnter(star(4))
    fireEvent.click(star(4))
    // 點完滑過第 5 顆再滑出星排：預覽歸零，回到已選的 4 顆
    fireEvent.mouseEnter(star(5))
    fireEvent.mouseLeave(star(5).parentElement!)
    expect(filled()).toEqual([true, true, true, true, false])
    expect(submit().disabled).toBe(false)
  })

  it('未評分時 5 顆全空心且非品牌色', () => {
    render(<StarRow historyId="h-1" onRated={vi.fn()} />)
    expect(filled()).toEqual([false, false, false, false, false])
    expect(brand()).toEqual([false, false, false, false, false])
  })

  // 手機／鍵盤沒有 hover：focus 走的是同一個預覽，後到的那個說了算，離開星排就歸零
  it('滑入與 focus 都寫入同一個預覽狀態', () => {
    render(<StarRow historyId="h-1" onRated={vi.fn()} />)
    fireEvent.mouseEnter(star(3))
    expect(filled()).toEqual([true, true, true, false, false])
    fireEvent.focus(star(2))
    expect(filled()).toEqual([true, true, false, false, false])
    fireEvent.blur(star(2))
    expect(filled()).toEqual([false, false, false, false, false])

    fireEvent.focus(star(3))
    expect(filled()).toEqual([true, true, true, false, false])
  })
})

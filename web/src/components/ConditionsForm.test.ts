import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberRow } from '../lib/types'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  from: vi.fn(),
  update: vi.fn(),
  eqRoom: vi.fn(),
  eqUser: vi.fn(),
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const setter = vi.fn()
      mocks.stateSetters[mocks.stateIndex++] = setter
      return [initial, setter]
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: vi.fn(),
  }
})

vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from } }))

type ElementLike = {
  type?: unknown
  props?: { children?: unknown; onClick?: () => void | Promise<void> }
}

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node && typeof node === 'object') return textContent((node as ElementLike).props?.children)
  return ''
}

function findButton(node: unknown, label: string): ElementLike {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found.type) return found
    }
    return {}
  }
  if (!node || typeof node !== 'object') return {}
  const element = node as ElementLike
  if (element.type === 'button' && textContent(element.props?.children) === label) return element
  return findButton(element.props?.children, label)
}

const me: MemberRow = {
  room_id: 'room-1', user_id: 'user-b', budget_max: 800, cuisines: [], dietary: [],
  max_distance_m: 1000, transport: 'walking', ready: false,
}

describe('ConditionsForm 條件寫入防線', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.eqUser.mockReset().mockResolvedValue({ error: null, count: 1 })
    mocks.eqRoom.mockReset().mockReturnValue({ eq: mocks.eqUser })
    mocks.update.mockReset().mockReturnValue({ eq: mocks.eqRoom })
    mocks.from.mockReset().mockReturnValue({ update: mocks.update })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  async function clickReady() {
    const { default: ConditionsForm } = await import('./ConditionsForm')
    const tree = ConditionsForm({ me, isHost: false })
    const ready = findButton(tree, '我準備好了')
    if (!ready.props?.onClick) throw new Error('找不到準備按鈕')
    await ready.props.onClick()
    await vi.advanceTimersByTimeAsync(401)
  }

  it('儲存以 count:exact 寫入並鎖定 room_id 與 user_id 兩個條件', async () => {
    await clickReady()
    expect(mocks.update).toHaveBeenCalledWith({
      budget_max: 800, cuisines: [], dietary: [], max_distance_m: 1000,
      transport: 'walking', ready: true,
    }, { count: 'exact' })
    expect(mocks.eqRoom).toHaveBeenCalledWith('room_id', 'room-1')
    expect(mocks.eqUser).toHaveBeenCalledWith('user_id', 'user-b')
  })

  it('count 0（RLS 凍結）時還原表單並顯示凍結錯誤', async () => {
    mocks.eqUser.mockResolvedValue({ error: null, count: 0 })
    await clickReady()
    // 斷最後一次呼叫：save() 先 setForm(next)，失敗才 setForm(savedRef.current)——
    // 用 toHaveBeenCalledWith 會在 useEffect stub 改為執行時靜默變 vacuous
    expect(mocks.stateSetters[0].mock.calls.at(-1)).toEqual([me])
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('儲存失敗：房間可能已開始選餐，條件已凍結')
  })
})

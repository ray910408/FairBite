import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MemberRow } from '../lib/types'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as Array<() => void | (() => void)>,
  refs: [] as Array<{ current: unknown }>,
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
    useRef: (initial: unknown) => {
      const ref = { current: initial }
      mocks.refs.push(ref)
      return ref
    },
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
  }
})

vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from } }))

type ElementLike = {
  type?: unknown
  props?: {
    children?: unknown
    onClick?: () => void | Promise<void>
    onChange?: (event: { target: { value: string } }) => void
  }
}

type InputLike = { type?: unknown; props?: { disabled?: boolean; children?: unknown } }

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

function findInput(node: unknown): ElementLike {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findInput(child)
      if (found.type) return found
    }
    return {}
  }
  if (!node || typeof node !== 'object') return {}
  const element = node as ElementLike
  if (element.type === 'input') return element
  return findInput(element.props?.children)
}

function collectDisabledStates(node: unknown, out: boolean[] = []): boolean[] {
  if (Array.isArray(node)) {
    for (const child of node) collectDisabledStates(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  const el = node as InputLike
  if (el.type === 'input' || el.type === 'button') out.push(el.props?.disabled === true)
  collectDisabledStates(el.props?.children, out)
  return out
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
    mocks.effects = []
    mocks.refs = []
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
  }

  it('條件批次寫入只含五個條件欄位，不夾帶 ready', async () => {
    const { default: ConditionsForm } = await import('./ConditionsForm')
    const tree = ConditionsForm({ me, isHost: false })
    const budget = findInput(tree)
    if (!budget.props?.onChange) throw new Error('找不到預算輸入')
    budget.props.onChange({ target: { value: '900' } })
    await vi.advanceTimersByTimeAsync(401)

    const [payload, options] = mocks.update.mock.calls.at(-1)!
    expect(payload).toEqual({
      budget_max: 900, cuisines: [], dietary: [], max_distance_m: 1000,
      transport: 'walking',
    })
    expect(payload).not.toHaveProperty('ready')
    expect(options).toEqual({ count: 'exact' })
    expect(mocks.eqRoom).toHaveBeenCalledWith('room_id', 'room-1')
    expect(mocks.eqUser).toHaveBeenCalledWith('user_id', 'user-b')
  })

  it('ready 點擊立即走專用 count:exact 寫入，不等待 debounce', async () => {
    await clickReady()
    expect(mocks.update).toHaveBeenCalledWith({ ready: true }, { count: 'exact' })
    expect(mocks.eqRoom).toHaveBeenCalledWith('room_id', 'room-1')
    expect(mocks.eqUser).toHaveBeenCalledWith('user_id', 'user-b')
    expect(mocks.update).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(401)
    expect(mocks.update).toHaveBeenCalledTimes(1)
  })

  it('pending 條件寫入成功不會倒退 ready 專用寫入保存的值', async () => {
    const { default: ConditionsForm } = await import('./ConditionsForm')
    const tree = ConditionsForm({ me, isHost: false })
    const budget = findInput(tree)
    const ready = findButton(tree, '我準備好了')
    if (!budget.props?.onChange || !ready.props?.onClick) throw new Error('找不到條件或準備輸入')

    budget.props.onChange({ target: { value: '900' } })
    await ready.props.onClick()
    await vi.advanceTimersByTimeAsync(401)

    expect((mocks.refs[0].current as MemberRow).ready).toBe(true)
  })

  it('ready 專用寫入 count 0 時還原 ready 並顯示凍結錯誤', async () => {
    mocks.eqUser.mockResolvedValue({ error: null, count: 0 })
    await clickReady()
    const rollback = mocks.stateSetters[0].mock.calls.at(-1)?.[0]
    expect(rollback).toBeTypeOf('function')
    expect(rollback({ ...me, ready: true }).ready).toBe(false)
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('儲存失敗：房間可能已開始選餐，條件已凍結')
  })

  it('me.ready 變更的同步 effect 會把權威 ready 寫回 form（雙分頁凍結不被 stale 繞過）', async () => {
    const { default: ConditionsForm } = await import('./ConditionsForm')
    ConditionsForm({ me: { ...me, ready: true }, isHost: false })
    for (const fn of mocks.effects) fn()
    // setForm 收到 updater：以 stale form（ready:false）餵入，必須修正為權威 ready:true
    const updaterCalls = mocks.stateSetters[0].mock.calls
      .map(args => args[0]).filter(a => typeof a === 'function')
    expect(updaterCalls.length).toBeGreaterThan(0)
    const updated = updaterCalls.at(-1)!({ ...me, ready: false })
    expect(updated.ready).toBe(true)
  })
})

describe('ConditionsForm 凍結（準備／搜尋中）', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.effects = []
    mocks.refs = []
  })

  it('成員 ready 時所有條件輸入凍結、ready 鈕仍可點', async () => {
    const { default: ConditionsForm } = await import('./ConditionsForm')
    const tree = ConditionsForm({ me: { ...me, ready: true }, isHost: false })
    const ready = findButton(tree, '已準備（點擊取消）')
    expect(ready.type).toBe('button')
    expect((ready as InputLike).props?.disabled).not.toBe(true)
    // ready 鈕以外的 input/button 全部 disabled
    const states = collectDisabledStates(tree)
    const enabledCount = states.filter(s => !s).length
    expect(enabledCount).toBe(1) // 只剩 ready 鈕
  })

  it('disabled prop（房主搜尋中）時全部輸入凍結', async () => {
    const { default: ConditionsForm } = await import('./ConditionsForm')
    const tree = ConditionsForm({ me, isHost: true, disabled: true })
    const states = collectDisabledStates(tree)
    expect(states.every(s => s)).toBe(true) // 房主無 ready 鈕，全凍
  })

  it('未準備且未搜尋時可編輯', async () => {
    const { default: ConditionsForm } = await import('./ConditionsForm')
    const tree = ConditionsForm({ me, isHost: false })
    const states = collectDisabledStates(tree)
    expect(states.some(s => !s)).toBe(true)
    expect(states.filter(s => s)).toHaveLength(0)
  })
})

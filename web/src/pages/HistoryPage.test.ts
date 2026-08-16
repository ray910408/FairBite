import { beforeEach, describe, expect, it, vi } from 'vitest'

// 足跡頁的「回首頁」同樣＝離席（ADR-0007，HomePage mount 無條件 leaveRooms），
// 但只有「人還在房裡」時才該攔。風格比照 HomePage.test.ts：直接把 component 當函式呼叫。
const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as Array<() => void | (() => void)>,
  from: vi.fn(),
  members: {} as { data?: unknown; error?: unknown },
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = mocks.stateIndex++
      const value = mocks.stateValues[index] === undefined ? initial : mocks.stateValues[index]
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value, setter]
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
    useCallback: (fn: unknown) => fn,
    useMemo: (fn: () => unknown) => fn(),
  }
})

vi.mock('react-router-dom', () => ({ Link: 'a' }))
vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from } }))

type NodeLike = { type?: unknown; props?: Record<string, unknown> }

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node && typeof node === 'object') return textContent((node as NodeLike).props?.children)
  return ''
}

function findNode(node: unknown, pred: (el: NodeLike) => boolean): NodeLike | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findNode(child, pred)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  const element = node as NodeLike
  if (pred(element)) return element
  return findNode(element.props?.children, pred)
}

const byText = (type: string, label: string) =>
  (el: NodeLike) => el.type === type && textContent(el) === label

type FakeEvent = { preventDefault: () => void; currentTarget: unknown }
const asHandler = (v: unknown) => v as ((e: FakeEvent) => void) | undefined

const IN_ROOM = { id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 2 }

async function render(leaveTarget: unknown, leaveOpen = false, total = 0) {
  mocks.stateIndex = 0
  mocks.stateValues = [{ phase: 'ready', rows: [], total }, null, leaveTarget, leaveOpen]
  mocks.stateSetters = []
  mocks.effects = []
  const { default: HistoryPage } = await import('./HistoryPage')
  return HistoryPage()
}

beforeEach(() => {
  mocks.members = { data: [], error: null }
  mocks.from.mockReset().mockImplementation((table: string) => ({
    select: () => table === 'room_members'
      ? Promise.resolve(mocks.members)
      : { order: () => ({ limit: () => Promise.resolve({ data: [], error: null, count: 0 }) }) },
  }))
})

describe('足跡頁回首頁離席確認', () => {
  it('不在房間：回首頁是一般導覽，不攔也不開 dialog', async () => {
    const tree = await render(null)
    const home = findNode(tree, byText('a', '回首頁'))
    expect(home?.props?.to).toBe('/')
    expect(home?.props?.onClick).toBeUndefined()
    expect(findNode(tree, el => el.props?.role === 'dialog')).toBeUndefined()
  })

  it('在房間：點回首頁不導航，改開確認', async () => {
    const tree = await render(IN_ROOM)
    const preventDefault = vi.fn()
    const onClick = asHandler(findNode(tree, byText('a', '回首頁'))?.props?.onClick)
    if (!onClick) throw new Error('找不到 header 回首頁')
    onClick({ preventDefault, currentTarget: { focus: vi.fn() } })
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.stateSetters[3]).toHaveBeenCalledWith(true)
    expect(textContent(tree)).not.toContain('回首頁會離開房間')
  })

  it('空狀態的「回首頁開一場」同樣被攔', async () => {
    const tree = await render(IN_ROOM)
    const preventDefault = vi.fn()
    const onClick = asHandler(findNode(tree, byText('a', '回首頁開一場'))?.props?.onClick)
    if (!onClick) throw new Error('找不到空狀態回首頁')
    onClick({ preventDefault, currentTarget: { focus: vi.fn() } })
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.stateSetters[3]).toHaveBeenCalledWith(true)
  })

  it('dialog 有名稱、有回到房間的入口，取消與 Esc 留在足跡頁', async () => {
    const tree = await render(IN_ROOM, true)
    const dialog = findNode(tree, el => el.props?.role === 'dialog')
    expect(dialog?.props?.['aria-modal']).toBe('true')
    expect(dialog?.props?.['aria-labelledby']).toBe('leave-title')

    // ADR-0007 Consequences：足跡頁需要不經首頁的回房入口
    expect(findNode(tree, byText('a', '回到房間'))?.props?.to).toBe('/room/room-1')
    expect(findNode(tree, byText('a', '仍要回首頁'))?.props?.to).toBe('/')

    const cancel = findNode(tree, byText('button', '取消'))
    expect(cancel?.props?.autoFocus).toBe(true)
    ;(cancel!.props!.onClick as () => void)()
    expect(mocks.stateSetters[3]).toHaveBeenCalledWith(false)

    mocks.stateSetters[3].mockClear()
    const onKeyDown = findNode(tree, el => typeof el.props?.onKeyDown === 'function')!
      .props!.onKeyDown as (e: { key: string }) => void
    onKeyDown({ key: 'Enter' })
    expect(mocks.stateSetters[3]).not.toHaveBeenCalled()
    onKeyDown({ key: 'Escape' })
    expect(mocks.stateSetters[3]).toHaveBeenCalledWith(false)
  })

  it('dialog 文案沿用 leaveNotice（voting 兩人）', async () => {
    const text = textContent(await render(IN_ROOM, true))
    expect(text).toContain('你目前還在房間 ABC123 裡')
    expect(text).toContain('你的投票會即刻作廢，候選盤面會重新計算')
    expect(text).toContain('你若是最後一位成員，房間會直接被刪除')
  })
})

describe('足跡頁所屬房間查詢', () => {
  async function runEffects(rows: unknown, error: unknown = null) {
    mocks.members = { data: rows, error }
    await render(null)
    for (const fn of mocks.effects) fn()
    await vi.waitFor(() => expect(mocks.from).toHaveBeenCalledWith('room_members'))
    await Promise.resolve()
  }

  it('回到成員列時記下房間與人數（RLS 只回我所屬房間的列）', async () => {
    await runEffects([
      { room_id: 'room-1', rooms: { code: 'ABC123', status: 'voting' } },
      { room_id: 'room-1', rooms: { code: 'ABC123', status: 'voting' } },
    ])
    expect(mocks.stateSetters[2]).toHaveBeenCalledWith({
      id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 2,
    })
  })

  it('查不到房間就不攔（沒有房可離）', async () => {
    await runEffects([])
    expect(mocks.stateSetters[2]).not.toHaveBeenCalled()
  })

  // fail-safe：附加查詢掛掉不得把回首頁鎖死
  it('查詢失敗也放行', async () => {
    await runEffects(null, { message: 'boom' })
    expect(mocks.stateSetters[2]).not.toHaveBeenCalled()
  })
})

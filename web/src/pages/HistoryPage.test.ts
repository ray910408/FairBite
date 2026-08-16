import { beforeEach, describe, expect, it, vi } from 'vitest'

// 足跡頁的「回首頁」同樣＝離席（ADR-0007，HomePage mount 無條件 leaveRooms），
// 但只有「人還在房裡」時才該攔。風格比照 HomePage.test.ts：直接把 component 當函式呼叫。
const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as Array<() => void | (() => void)>,
  from: vi.fn(),
  navigate: vi.fn(),
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

vi.mock('react-router-dom', () => ({ Link: 'a', useNavigate: () => mocks.navigate }))
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
const asHandler = (v: unknown) => v as ((e: FakeEvent) => Promise<void>) | undefined

const room = (id: string, code: string, status: string) =>
  ({ room_id: id, rooms: { code, status } })

// state 索引：0 state / 1 expandedId / 2 membership / 3 leaveDialog / 4 leaveChecking
const MEMBERSHIP = 2
const DIALOG = 3
const CHECKING = 4

async function render(membership: string, dialog: unknown = undefined, total = 0) {
  mocks.stateIndex = 0
  mocks.stateValues = [{ phase: 'ready', rows: [], total }, null, membership, dialog]
  mocks.stateSetters = []
  mocks.effects = []
  const { default: HistoryPage } = await import('./HistoryPage')
  return HistoryPage()
}

async function clickHome(tree: unknown, label = '回首頁') {
  const preventDefault = vi.fn()
  const onClick = asHandler(findNode(tree, byText('a', label))?.props?.onClick)
  if (!onClick) throw new Error(`找不到連結：${label}`)
  await onClick({ preventDefault, currentTarget: { focus: vi.fn() } })
  return preventDefault
}

beforeEach(() => {
  mocks.navigate.mockReset()
  mocks.members = { data: [], error: null }
  mocks.from.mockReset().mockImplementation((table: string) => ({
    select: () => table === 'room_members'
      ? Promise.resolve(mocks.members)
      : { order: () => ({ limit: () => Promise.resolve({ data: [], error: null, count: 0 }) }) },
  }))
})

describe('足跡頁回首頁離席確認', () => {
  it('不在房間：回首頁是一般導覽，不攔也不查', async () => {
    const tree = await render('none')
    const preventDefault = await clickHome(tree)
    expect(preventDefault).not.toHaveBeenCalled()
    expect(mocks.stateSetters[DIALOG]).not.toHaveBeenCalled()
    expect(mocks.from).not.toHaveBeenCalledWith('room_members')
  })

  // P1-A：mount 查詢 settle 前的空窗——這段時間點下去一樣會離席，不得放行
  it('查詢還沒 settle（checking）就點回首頁：照樣攔住並確認', async () => {
    mocks.members = { data: [room('room-1', 'ABC123', 'voting')], error: null }
    const tree = await render('checking')
    const preventDefault = await clickHome(tree)
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 1 }],
    })
  })

  // P1-B：本頁久留是預期用法，狀態會在使用者眼前變；文案只能來自開啟當下的重查
  it('開啟時重查，用新鮮的 status 而非 mount 快照', async () => {
    mocks.members = {
      data: [room('room-1', 'ABC123', 'candidates'), room('room-1', 'ABC123', 'candidates')],
      error: null,
    }
    const tree = await render('in-room')
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'candidates', memberCount: 2 }],
    })
    expect(mocks.stateSetters[CHECKING]).toHaveBeenCalledWith(true)
    expect(mocks.stateSetters[CHECKING]).toHaveBeenCalledWith(false)
  })

  it('重查失敗改用保守文案，不拿過期快照講後果', async () => {
    mocks.members = { data: null, error: { message: 'boom' } }
    const tree = await render('in-room')
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({ kind: 'unknown' })

    const rendered = await render('in-room', { kind: 'unknown' })
    const text = textContent(rendered)
    expect(text).toContain('房間現況查不到')
    expect(text).not.toContain('可用邀請碼重新加入')
    expect(text).not.toContain('會直接被刪除')
    expect(findNode(rendered, byText('a', '回到房間'))).toBeUndefined() // 不知道回哪間
    expect(findNode(rendered, byText('a', '仍要回首頁'))?.props?.to).toBe('/')
  })

  it('重查發現已經不在任何房間：直接導航，不跳確認', async () => {
    mocks.members = { data: [], error: null }
    const tree = await render('in-room')
    await clickHome(tree)
    expect(mocks.navigate).toHaveBeenCalledWith('/')
    expect(mocks.stateSetters[DIALOG]).not.toHaveBeenCalled()
    expect(mocks.stateSetters[MEMBERSHIP]).toHaveBeenCalledWith('none')
  })

  it('空狀態的「回首頁開一場」同樣被攔', async () => {
    mocks.members = { data: [room('room-1', 'ABC123', 'voting')], error: null }
    const tree = await render('in-room')
    const preventDefault = await clickHome(tree, '回首頁開一場')
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalled()
  })

  const oneRoom = {
    kind: 'rooms',
    rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 2 }],
  }

  it('dialog 有名稱、有回到房間的入口，取消與 Esc 留在足跡頁', async () => {
    const tree = await render('in-room', oneRoom)
    const dialog = findNode(tree, el => el.props?.role === 'dialog')
    expect(dialog?.props?.['aria-modal']).toBe('true')
    expect(dialog?.props?.['aria-labelledby']).toBe('leave-title')

    // ADR-0007 Consequences：足跡頁需要不經首頁的回房入口
    expect(findNode(tree, byText('a', '回到房間'))?.props?.to).toBe('/room/room-1')
    expect(findNode(tree, byText('a', '仍要回首頁'))?.props?.to).toBe('/')

    const cancel = findNode(tree, byText('button', '取消'))
    expect(cancel?.props?.autoFocus).toBe(true)
    ;(cancel!.props!.onClick as () => void)()
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith(null)

    mocks.stateSetters[DIALOG].mockClear()
    const onKeyDown = findNode(tree, el => typeof el.props?.onKeyDown === 'function')!
      .props!.onKeyDown as (e: { key: string }) => void
    onKeyDown({ key: 'Enter' })
    expect(mocks.stateSetters[DIALOG]).not.toHaveBeenCalled()
    onKeyDown({ key: 'Escape' })
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith(null)
  })

  it('單房 dialog 文案沿用 leaveNotice（voting 兩人）', async () => {
    const text = textContent(await render('in-room', oneRoom))
    expect(text).toContain('你目前還在房間 ABC123 裡')
    expect(text).toContain('你的投票會即刻作廢，候選盤面會重新計算')
    expect(text).toContain('你若是最後一位成員，房間會直接被刪除')
  })

  // P2-A：leave 是全退，兩個房籍都要講（舊房 leave 逾時後又建新房就會這樣）
  it('多房籍：兩個房的邀請碼與各自後果都列出，並各有回房入口', async () => {
    const tree = await render('in-room', {
      kind: 'rooms',
      rooms: [
        { id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1 },
        { id: 'room-2', code: 'BBB222', status: 'decided', memberCount: 3 },
      ],
    })
    const text = textContent(tree)
    expect(text).toContain('你目前在 2 個房間裡，回首頁會一次全部離開')
    expect(text).toContain('房間 AAA111')
    expect(text).toContain('房間 BBB222')
    expect(text).toContain('邀請碼 AAA111 會跟著失效') // lobby 單人
    expect(text).toContain('抽中的結果之後只能在「足跡」查看') // decided 多人
    expect(findNode(tree, byText('a', '回到 AAA111'))?.props?.to).toBe('/room/room-1')
    expect(findNode(tree, byText('a', '回到 BBB222'))?.props?.to).toBe('/room/room-2')
    // 不替使用者猜要回哪一間
    expect(findNode(tree, byText('a', '回到房間'))).toBeUndefined()
  })
})

describe('足跡頁 mount 房籍查詢', () => {
  async function runMountEffects(rows: unknown, error: unknown = null) {
    mocks.members = { data: rows, error }
    await render('checking')
    for (const fn of mocks.effects) fn()
    await vi.waitFor(() => expect(mocks.stateSetters[MEMBERSHIP]).toHaveBeenCalled())
  }

  it('查到房間 → in-room（之後點回首頁會攔）', async () => {
    await runMountEffects([room('room-1', 'ABC123', 'voting')])
    expect(mocks.stateSetters[MEMBERSHIP]).toHaveBeenCalledWith('in-room')
  })

  it('查無房間 → none（放行）', async () => {
    await runMountEffects([])
    expect(mocks.stateSetters[MEMBERSHIP]).toHaveBeenCalledWith('none')
  })

  // fail-safe：附加查詢掛掉不得把回首頁鎖死
  it('查詢失敗 → none（放行）', async () => {
    await runMountEffects(null, { message: 'boom' })
    expect(mocks.stateSetters[MEMBERSHIP]).toHaveBeenCalledWith('none')
  })

  it('多房籍：依 room_id 分組各自算人數', async () => {
    mocks.members = {
      data: [
        room('room-1', 'AAA111', 'lobby'),
        room('room-2', 'BBB222', 'decided'),
        room('room-2', 'BBB222', 'decided'),
      ],
      error: null,
    }
    const tree = await render('in-room')
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [
        { id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1 },
        { id: 'room-2', code: 'BBB222', status: 'decided', memberCount: 2 },
      ],
    })
  })
})

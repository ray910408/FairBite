import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
  getUid: vi.fn(),
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
vi.mock('../lib/uid', () => ({ getUid: mocks.getUid }))

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

// host_id 預設別人：房主移交敘述有自己的測試，其餘案例不受它干擾
const room = (id: string, code: string, status: string, hostId = 'someone-else') =>
  ({ room_id: id, rooms: { code, status, host_id: hostId } })

// state 索引：0 state / 1 expandedId / 2 leaveDialog / 3 leaveChecking
const DIALOG = 2
const CHECKING = 3

async function render(dialog: unknown = undefined, total = 0) {
  mocks.stateIndex = 0
  mocks.stateValues = [{ phase: 'ready', rows: [], total }, null, dialog]
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

// 關閉 dialog 後的焦點還原走 rAF（背景整塊 inert，要等移除它的那次 commit 才聚焦得到），
// onRated 的收合也是——node 測試環境沒有這個瀏覽器全域，補一個等價的排程器
beforeEach(() => vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0)))
afterEach(() => vi.unstubAllGlobals())

beforeEach(() => {
  mocks.navigate.mockReset()
  mocks.members = { data: [], error: null }
  mocks.getUid.mockReset().mockResolvedValue('me')
  mocks.from.mockReset().mockImplementation((table: string) => ({
    select: () => table === 'room_members'
      ? Promise.resolve(mocks.members)
      : { order: () => ({ limit: () => Promise.resolve({ data: [], error: null, count: 0 }) }) },
  }))
})

describe('足跡頁回首頁離席確認', () => {
  // 沒有任何房籍快照可依賴：點擊當下一律先查（進頁時沒房、之後在別的分頁建房是
  // ADR-0007 自己承認的情境，快照放行就會靜默退掉那個新房）
  it('點回首頁一律先攔下來查，查到房就確認', async () => {
    mocks.members = { data: [room('room-1', 'ABC123', 'voting')], error: null }
    const tree = await render()
    const preventDefault = await clickHome(tree)
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.from).toHaveBeenCalledWith('room_members')
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 1, isHost: false }],
    })
  })

  // 文案只能來自點擊當下的查詢：本頁久留是預期用法，status／人數會在使用者眼前變
  it('用點擊當下查到的 status 與人數', async () => {
    mocks.members = {
      data: [room('room-1', 'ABC123', 'candidates'), room('room-1', 'ABC123', 'candidates')],
      error: null,
    }
    const tree = await render()
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'candidates', memberCount: 2, isHost: false }],
    })
    expect(mocks.stateSetters[CHECKING]).toHaveBeenCalledWith(true)
    expect(mocks.stateSetters[CHECKING]).toHaveBeenCalledWith(false)
  })

  it('查詢失敗改用保守文案，不假裝知道後果', async () => {
    mocks.members = { data: null, error: { message: 'boom' } }
    const tree = await render()
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({ kind: 'unknown' })

    const rendered = await render({ kind: 'unknown' })
    const text = textContent(rendered)
    expect(text).toContain('房間現況查不到')
    expect(text).not.toContain('可用邀請碼重新加入')
    expect(text).not.toContain('會直接被刪除')
    expect(findNode(rendered, byText('a', '回到房間'))).toBeUndefined() // 不知道回哪間
    expect(findNode(rendered, byText('a', '仍要回首頁'))?.props?.to).toBe('/')
  })

  it('查到真的沒房可離：直接導航，不跳確認', async () => {
    mocks.members = { data: [], error: null }
    const tree = await render()
    await clickHome(tree)
    expect(mocks.navigate).toHaveBeenCalledWith('/')
    expect(mocks.stateSetters[DIALOG]).not.toHaveBeenCalled()
  })

  it('空狀態的「回首頁開一場」同樣被攔', async () => {
    mocks.members = { data: [room('room-1', 'ABC123', 'voting')], error: null }
    const tree = await render()
    const preventDefault = await clickHome(tree, '回首頁開一場')
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalled()
  })

  const oneRoom = {
    kind: 'rooms',
    rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 2, isHost: false }],
  }

  it('dialog 有名稱、有回到房間的入口，取消與 Esc 留在足跡頁', async () => {
    const tree = await render(oneRoom)
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

  // PR #17 回歸：背景整塊帶著 inert，而 setLeaveDialog(null) 不同步 flush——同一輪呼叫
  // focus() 時觸發元素還在 inert 子樹內，瀏覽器直接忽略，焦點掉回 document.body。
  // 斷言的是「延後」這件事本身：關閉當下不得呼叫 focus()，要等 rAF 那一拍才還原。
  it('關閉後的焦點還原排到 rAF，不在還帶著 inert 的同一輪呼叫', async () => {
    const raf = vi.fn((_cb: () => void) => 0)
    vi.stubGlobal('requestAnimationFrame', raf)
    try {
      const tree = await render(oneRoom)
      const focus = vi.fn()
      // 觸發元素由 askLeave 當場記下（兩個回首頁入口共用一個 dialog）
      const onClick = asHandler(findNode(tree, byText('a', '回首頁'))?.props?.onClick)
      if (!onClick) throw new Error('找不到回首頁連結')
      await onClick({ preventDefault: vi.fn(), currentTarget: { focus } })

      raf.mockClear()
      const cancel = findNode(tree, byText('button', '取消'))
      ;(cancel!.props!.onClick as () => void)()
      expect(focus).not.toHaveBeenCalled() // 這一輪背景還是 inert，現在 focus() 只會被忽略
      expect(raf).toHaveBeenCalledTimes(1)
      raf.mock.calls[0][0]()
      expect(focus).toHaveBeenCalledTimes(1) // 下一幀 inert 已移除，這次才真的聚焦得到

      raf.mockClear()
      focus.mockClear()
      const onKeyDown = findNode(tree, el => typeof el.props?.onKeyDown === 'function')!
        .props!.onKeyDown as (e: { key: string }) => void
      onKeyDown({ key: 'Escape' })
      expect(focus).not.toHaveBeenCalled()
      expect(raf).toHaveBeenCalledTimes(1)
      raf.mock.calls[0][0]()
      expect(focus).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
  })

  // fixed 遮罩擋得住指標，對 tab 順序毫無作用：沒有 inert，鍵盤可以 tab 到背景的
  // 「補評」chip 並按 Enter（Codex P2）
  it('dialog 開著時背景 inert，dialog 本身在 inert 子樹外', async () => {
    const closed = findNode(await render(), el => el.props?.className === 'min-h-screen')
    expect(closed?.props?.inert).toBe(false)

    const tree = await render(oneRoom)
    const background = findNode(tree, el => el.props?.className === 'min-h-screen')
    expect(background?.props?.inert).toBe(true)
    expect(findNode(background, el => el.props?.role === 'dialog')).toBeUndefined()
    expect(findNode(tree, el => el.props?.role === 'dialog')).toBeDefined()
    expect(findNode(background, el => el.type === 'a')).toBeDefined() // 背景確實有可聚焦控制項
  })

  it('單房 dialog 文案沿用 leaveNotice（voting 兩人）', async () => {
    const text = textContent(await render(oneRoom))
    expect(text).toContain('你目前還在房間 ABC123 裡')
    expect(text).toContain('你的投票會即刻作廢，候選盤面會重新計算')
    expect(text).toContain('你若是最後一位成員，房間會直接被刪除')
  })

  // P2-A：leave 是全退，兩個房籍都要講（舊房 leave 逾時後又建新房就會這樣）
  it('多房籍：兩個房的邀請碼與各自後果都列出，並各有回房入口', async () => {
    const tree = await render({
      kind: 'rooms',
      rooms: [
        { id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1, isHost: true },
        { id: 'room-2', code: 'BBB222', status: 'decided', memberCount: 3, isHost: true },
      ],
    })
    const text = textContent(tree)
    expect(text).toContain('你目前在 2 個房間裡，回首頁會一次全部離開')
    expect(text).toContain('房間 AAA111')
    expect(text).toContain('房間 BBB222')
    expect(text).toContain('邀請碼 AAA111 會跟著失效') // lobby 單人
    expect(text).toContain('抽中的結果之後只能在「足跡」查看') // decided 多人
    // 房主移交只講在有人可以繼任的那一間（AAA111 單人房是直接刪房）
    expect(text.split('房主身分會移交給').length - 1).toBe(1)
    expect(findNode(tree, byText('a', '回到 AAA111'))?.props?.to).toBe('/room/room-1')
    expect(findNode(tree, byText('a', '回到 BBB222'))?.props?.to).toBe('/room/room-2')
    // 不替使用者猜要回哪一間
    expect(findNode(tree, byText('a', '回到房間'))).toBeUndefined()
  })

  // 多房籍在矮視窗（320x568）會長到超出畫面；垂直置中時上下一起溢出，
  // 「取消」和「仍要回首頁」會變成點不到
  it('dialog 限高在視窗內，只有中段捲動，控制項不會被捲走', async () => {
    const tree = await render({
      kind: 'rooms',
      rooms: ['AAA111', 'BBB222', 'CCC333'].map((code, i) =>
        ({ id: `room-${i}`, code, status: 'voting', memberCount: 3, isHost: true })),
    })
    const dialog = findNode(tree, el => el.props?.role === 'dialog')
    const dialogClass = String(dialog?.props?.className ?? '')
    expect(dialogClass).toContain('max-h-full') // 卡片不得長過視窗
    expect(dialogClass).toContain('flex-col')

    const scroller = findNode(dialog,
      el => String(el.props?.className ?? '').includes('overflow-y-auto'))
    expect(scroller).toBeDefined()
    expect(String(scroller?.props?.className)).toContain('min-h-0') // 沒有它 flex 不肯縮
    expect(textContent(scroller)).toContain('房間 CCC333') // 房間清單在捲動區裡
    // 控制項在捲動區外：內容再長也構得到
    expect(findNode(scroller, byText('button', '取消'))).toBeUndefined()
    expect(findNode(scroller, byText('a', '仍要回首頁'))).toBeUndefined()
    expect(findNode(tree, byText('button', '取消'))).toBeDefined()
    expect(findNode(tree, byText('a', '仍要回首頁'))?.props?.to).toBe('/')
  })
})

describe('足跡頁房籍查詢', () => {
  // 多分頁：這個分頁進來時沒房，之後在別的分頁建了房——沒有快照可放行，一律當場查
  it('進頁時沒房、點擊時已在房間：照樣攔住並確認', async () => {
    mocks.members = { data: [], error: null }
    const tree = await render()
    mocks.members = { data: [room('room-9', 'NEW999', 'lobby')], error: null } // 另一分頁建了房
    const preventDefault = await clickHome(tree)
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-9', code: 'NEW999', status: 'lobby', memberCount: 1, isHost: false }],
    })
  })

  it('mount 不查房籍（沒有會過期的快照）', async () => {
    await render()
    for (const fn of mocks.effects) fn()
    await vi.waitFor(() => expect(mocks.from).toHaveBeenCalledWith('dining_history'))
    expect(mocks.from).not.toHaveBeenCalledWith('room_members')
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
    const tree = await render()
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [
        { id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1, isHost: false },
        { id: 'room-2', code: 'BBB222', status: 'decided', memberCount: 2, isHost: false },
      ],
    })
  })

  // 房主退出會移交（ADR-0007、leave.go）：host_id 要一起查回來跟自己的 uid 比對
  it('查回 host_id 比對 uid，房主房標成 isHost', async () => {
    mocks.members = {
      data: [room('room-1', 'AAA111', 'lobby', 'me'), room('room-2', 'BBB222', 'lobby')],
      error: null,
    }
    const tree = await render()
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [
        { id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1, isHost: true },
        { id: 'room-2', code: 'BBB222', status: 'lobby', memberCount: 1, isHost: false },
      ],
    })
  })

  // 拿不到 uid 就不知道自己是不是房主——不猜，交給 leaveNotice 用條件句
  it('取不到 uid 時 isHost = null（不猜）', async () => {
    mocks.getUid.mockResolvedValue(null)
    mocks.members = { data: [room('room-1', 'AAA111', 'lobby', 'me')], error: null }
    const tree = await render()
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1, isHost: null }],
    })
  })

  it('getUid 拋錯只讓 isHost 退回 null，不整份放棄成 unknown', async () => {
    mocks.getUid.mockRejectedValue(new Error('no session'))
    mocks.members = { data: [room('room-1', 'AAA111', 'lobby', 'me')], error: null }
    const tree = await render()
    await clickHome(tree)
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1, isHost: null }],
    })
  })
})

// aria-busy 擋不住點擊：兩次點擊之間房籍會變（多分頁是 ADR-0007 承認的情境），
// 第一次的舊回應若晚到就會蓋掉第二次的結果
describe('足跡頁離席查詢的世代守衛', () => {
  it('晚到的舊「沒有房間」回應不得跳過剛開好的 dialog', async () => {
    let releaseFirst!: () => void
    const first = new Promise(resolve => {
      releaseFirst = () => resolve({ data: [], error: null }) // 第一次點擊時真的沒房
    })
    // 第二次點擊：另一個分頁剛加入房，這次的查詢先回來
    const second = Promise.resolve({ data: [room('room-9', 'NEW999', 'lobby')], error: null })
    const queue: unknown[] = [first, second]
    mocks.from.mockImplementation((table: string) => ({
      select: () => table === 'room_members'
        ? (queue.shift() ?? second)
        : { order: () => ({ limit: () => Promise.resolve({ data: [], error: null, count: 0 }) }) },
    }))

    const tree = await render()
    const firstClick = clickHome(tree)
    const secondClick = clickHome(tree)
    await secondClick
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-9', code: 'NEW999', status: 'lobby', memberCount: 1, isHost: false }],
    })

    releaseFirst() // 舊回應姍姍來遲
    await firstClick
    expect(mocks.navigate).not.toHaveBeenCalled() // 沒有繞過 dialog 直接退房
    expect(mocks.stateSetters[DIALOG]).toHaveBeenCalledTimes(1)
    // 兩次點擊各開一次 busy，只有最後一次的回應負責關掉
    expect(mocks.stateSetters[CHECKING].mock.calls).toEqual([[true], [true], [false]])
  })
})

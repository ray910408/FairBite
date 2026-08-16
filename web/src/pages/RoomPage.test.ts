import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  useRoom: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  navigate: vi.fn(),
  getUid: vi.fn(),
  members: {} as { data?: unknown; error?: unknown },
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = mocks.stateIndex++
      const value = index < mocks.stateValues.length ? mocks.stateValues[index] : initial
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value, setter]
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: vi.fn(),
  }
})

vi.mock('react-router-dom', () => ({
  Link: 'a',
  useParams: () => ({ id: 'room-1' }),
  useNavigate: () => mocks.navigate,
}))

vi.mock('../hooks/useRoom', () => ({ useRoom: mocks.useRoom }))
vi.mock('../lib/uid', () => ({ getUid: mocks.getUid }))

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: mocks.from,
  },
}))

vi.mock('../lib/api', () => ({
  searchRoom: vi.fn(async () => ({ error: null, warning: null })),
  startVoting: vi.fn(async () => null),
}))

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
  if (typeof element.type === 'function') {
    const parentStateIndex = mocks.stateIndex
    mocks.stateIndex = mocks.stateValues.length
    const rendered = element.type(element.props ?? {})
    mocks.stateIndex = parentStateIndex
    return findButton(rendered, label)
  }
  return findButton(element.props?.children, label)
}

type NodeLike = { type?: unknown; props?: Record<string, unknown> }

// findButton 只認 <button>；退房確認要抓 <a>／dialog 容器，用述詞找第一個符合的節點
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

async function renderRoomPage() {
  const { default: RoomPage } = await import('./RoomPage')
  return RoomPage()
}

describe('RoomPage meal_time draft intent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.stateIndex = 0
    mocks.stateValues = [false, '', '', false, false, '', '']
    mocks.stateSetters = []
    mocks.eq.mockReset().mockResolvedValue({ error: null, count: 1 })
    mocks.update.mockReset().mockReturnValue({ eq: mocks.eq })
    mocks.from.mockReset().mockReturnValue({ update: mocks.update })
    mocks.useRoom.mockReset().mockReturnValue({
      room: {
        id: 'room-1', code: 'ABC123', host_id: 'host', status: 'lobby',
        exploration: 'balanced', meal_time: null,
      },
      members: [], candidates: [], draw: null, myUserId: 'host', connected: true, notFound: false,
      loadError: false, refetch: vi.fn(),
      toggleVote: vi.fn(), myVote: null, ups: new Map(), vetoesRemaining: 2,
    })
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
  })

  it('馬上出發後於 debounce 內重選自訂時間會取消排隊中的歸零', async () => {
    const tree = await renderRoomPage()
    const nowButton = findButton(tree, '馬上出發')
    const customButton = findButton(tree, '自訂時間')
    if (!nowButton.props?.onClick || !customButton.props?.onClick) throw new Error('找不到用餐時間按鈕')

    await nowButton.props.onClick()
    await customButton.props.onClick()
    await vi.advanceTimersByTimeAsync(401)

    expect(mocks.stateSetters[4]).toHaveBeenCalledWith(true)
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('馬上出發寫入鎖定房間 id；count 0（RLS 擋下）時顯示用餐時間錯誤', async () => {
    mocks.eq.mockResolvedValue({ error: null, count: 0 })
    const tree = await renderRoomPage()
    const nowButton = findButton(tree, '馬上出發')
    if (!nowButton.props?.onClick) throw new Error('找不到用餐時間按鈕')
    await nowButton.props.onClick()
    await vi.advanceTimersByTimeAsync(401)
    expect(mocks.update).toHaveBeenCalledWith({ meal_time: null }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('id', 'room-1')
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('用餐時間更新失敗')
  })
})

describe('RoomPage 載入失敗（QA ISSUE-002）', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.stateValues = [false, '', '', false, false, '', '']
    mocks.stateSetters = []
  })

  it('loadError 顯示重試而非「找不到房間」，按重試呼叫 refetch', async () => {
    const refetch = vi.fn()
    mocks.useRoom.mockReset().mockReturnValue({
      room: null, members: [], candidates: [], draw: null, myUserId: '', connected: true,
      notFound: false, loadError: true, refetch,
      toggleVote: vi.fn(), myVote: null, ups: new Map(), vetoesRemaining: 2,
    })
    const tree = await renderRoomPage()
    expect(textContent(tree)).not.toContain('找不到房間')
    expect(textContent(tree)).toContain('房間載入失敗')
    const retry = findButton(tree, '重試')
    if (!retry.props?.onClick) throw new Error('找不到重試按鈕')
    await retry.props.onClick()
    expect(refetch).toHaveBeenCalled()
  })

  it('房間已載入時 loadError 顯示部分資料失敗並可重試', async () => {
    const refetch = vi.fn()
    mocks.useRoom.mockReset().mockReturnValue({
      room: {
        id: 'room-1', code: 'ABC123', host_id: 'host', status: 'lobby',
        exploration: 'balanced', meal_time: null,
      },
      members: [], candidates: [], draw: null, myUserId: 'host', connected: true,
      notFound: false, loadError: true, refetch,
      toggleVote: vi.fn(), myVote: null, ups: new Map(), vetoesRemaining: 2,
    })
    const tree = await renderRoomPage()
    expect(textContent(tree)).toContain('部分資料載入失敗')
    const retry = findButton(tree, '重試')
    if (!retry.props?.onClick) throw new Error('找不到重試按鈕')
    await retry.props.onClick()
    expect(refetch).toHaveBeenCalled()
  })
})

describe('房主免準備與搜尋 loading（Round 3）', () => {
  const lobbyRoom = {
    id: 'room-1', code: 'C', host_id: 'host-1', status: 'lobby',
    exploration: 'balanced', meal_time: null, cuisine_filter: false,
  }
  const hostMe = {
    room_id: 'room-1', user_id: 'host-1', budget_max: 800, cuisines: [], dietary: [],
    max_distance_m: 1000, transport: 'walking', ready: false,
    profiles: { display_name: '房主' },
  }
  const memberB = { ...hostMe, user_id: 'user-b', profiles: { display_name: '小B' } }

  function roomState(overrides: Record<string, unknown> = {}) {
    return {
      room: lobbyRoom,
      members: [hostMe, memberB],
      candidates: [],
      draw: null,
      myUserId: 'host-1',
      connected: true,
      notFound: false,
      loadError: false,
      refetch: vi.fn(),
      toggleVote: vi.fn(),
      myVote: () => null,
      ups: {},
      vetoesRemaining: 2,
      ...overrides,
    }
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.stateValues = [false, '', '', false, false, '', '']
    mocks.stateSetters = []
    mocks.eq.mockReset().mockResolvedValue({ error: null, count: 1 })
    mocks.update.mockReset().mockReturnValue({ eq: mocks.eq })
    mocks.from.mockReset().mockReturnValue({ update: mocks.update })
    mocks.useRoom.mockReset().mockReturnValue(roomState())
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('房主在 lobby 看不到「我準備好了」按鈕', async () => {
    const tree = await renderRoomPage()
    expect(findButton(tree, '我準備好了').type).toBeUndefined()
  })

  it('成員列表房主列不顯示「設定中」badge', async () => {
    const tree = await renderRoomPage()
    const text = textContent(tree)
    expect(text.split('設定中').length - 1).toBe(1)
  })

  it('確認視窗計數排除房主：僅房主未準備時不彈 confirm', async () => {
    const confirmSpy = vi.fn(() => true)
    vi.stubGlobal('confirm', confirmSpy)
    mocks.useRoom.mockReturnValue(roomState({ members: [hostMe, { ...memberB, ready: true }] }))
    const tree = await renderRoomPage()
    await findButton(tree, '開始搜尋餐廳').props!.onClick!()
    expect(confirmSpy).not.toHaveBeenCalled()
  })

  it('searching=true 時按鈕 disabled 顯示「搜尋中…」', async () => {
    mocks.stateValues[7] = true
    const tree = await renderRoomPage()
    const btn = findButton(tree, '搜尋中…') as { props?: { disabled?: boolean } }
    expect(btn.props?.disabled).toBe(true)
  })

  it('成員視角仍有「我準備好了」按鈕', async () => {
    mocks.useRoom.mockReturnValue(roomState({ myUserId: 'user-b' }))
    const tree = await renderRoomPage()
    expect(findButton(tree, '我準備好了').type).toBe('button')
  })

  it('lobby 顯示菜系過濾開關；成員視角 disabled', async () => {
    mocks.useRoom.mockReturnValue({ room: { ...lobbyRoom, cuisine_filter: false },
      members: [hostMe, memberB], myUserId: 'user-b',
      candidates: [], draw: null, connected: true, notFound: false, loadError: false,
      refetch: vi.fn(), toggleVote: vi.fn(), myVote: () => null, ups: {}, vetoesRemaining: 2 })
    const tree = await renderRoomPage()
    const toggle = findButton(tree, '關閉')
    expect((toggle as { props?: { disabled?: boolean } }).props?.disabled).toBe(true)
    expect(textContent(tree)).toContain('開啟後只保留符合成員菜系偏好的店')
  })

  // eng review 5A：寫入路徑防線——點了沒寫進 DB（或漏 count 防線）這條會紅
  it('host 點「開啟」以 count:exact 寫入 cuisine_filter', async () => {
    mocks.from.mockReturnValue({ update: mocks.update })
    mocks.update.mockReturnValue({ eq: mocks.eq })
    mocks.eq.mockResolvedValue({ error: null, count: 1 })
    mocks.useRoom.mockReturnValue({ room: { ...lobbyRoom, cuisine_filter: false },
      members: [hostMe, memberB], myUserId: 'host-1',
      candidates: [], draw: null, connected: true, notFound: false, loadError: false,
      refetch: vi.fn(), toggleVote: vi.fn(), myVote: () => null, ups: {}, vetoesRemaining: 2 })
    const tree = await renderRoomPage()
    await findButton(tree, '開啟').props!.onClick!()
    expect(mocks.update).toHaveBeenCalledWith({ cuisine_filter: true }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('id', 'room-1')
  })

  it('cuisine_filter 寫入 count 0（RLS 擋下）時顯示菜系過濾錯誤', async () => {
    mocks.eq.mockResolvedValue({ error: null, count: 0 })
    const tree = await renderRoomPage()
    await findButton(tree, '開啟').props!.onClick!()
    expect(mocks.update).toHaveBeenCalledWith({ cuisine_filter: true }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('id', 'room-1')
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('菜系過濾更新失敗')
  })

  it('host 點探索檔位鎖定房間 id；count 0 時顯示探索檔位錯誤', async () => {
    mocks.eq.mockResolvedValue({ error: null, count: 0 })
    const tree = await renderRoomPage()
    await findButton(tree, '熟悉').props!.onClick!()
    expect(mocks.update).toHaveBeenCalledWith({ exploration: 'familiar' }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('id', 'room-1')
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('探索檔位更新失敗')
  })

  it('startingVoting=true 時投票鈕 disabled 顯示「處理中…」', async () => {
    mocks.stateValues[8] = true
    mocks.useRoom.mockReturnValue(roomState({ room: { ...lobbyRoom, status: 'candidates' } }))
    const tree = await renderRoomPage()
    const btn = findButton(tree, '處理中…') as { props?: { disabled?: boolean } }
    expect(btn.props?.disabled).toBe(true)
  })
})

// QA：房間頁左上 logo 按下去靜默送出 leave（ADR-0007 回首頁＝離席），要先確認。
// Codex review r4：文案改成點擊當下 fetchLeaveRooms() 重查，不再讀 useRoom 的 room／members
//（前者在 rooms 查詢失敗時會停在過期快照，後者漏報殘留房籍）。
// leaveNotice 本身的分歧規則由 lib/leaveNotice.test.ts 窮舉，這裡只驗 RoomPage 的接線。
describe('回首頁離席確認', () => {
  const LEAVE_DIALOG = 9 // useState 呼叫順序：leaveDialog；新 state 只能接在它後面
  const LEAVE_CHECKING = 10

  const row = (id: string, code: string, status: string, hostId = 'someone-else') =>
    ({ room_id: id, rooms: { code, status, host_id: hostId } })

  function mount(dialog: unknown = null, overrides: Record<string, unknown> = {}) {
    mocks.stateIndex = 0
    mocks.stateValues = [false, '', '', false, false, '', '', false, false, dialog]
    mocks.stateSetters = []
    mocks.useRoom.mockReset().mockReturnValue({
      room: {
        id: 'room-1', code: 'ABC123', host_id: 'host', status: 'lobby',
        exploration: 'balanced', meal_time: null, cuisine_filter: false,
      },
      members: [], candidates: [], draw: null, myUserId: 'host', connected: true,
      notFound: false, loadError: false, refetch: vi.fn(),
      toggleVote: vi.fn(), myVote: () => null, ups: new Map(), vetoesRemaining: 2,
      ...overrides,
    })
    return renderRoomPage()
  }

  async function clickHome(tree: unknown) {
    const preventDefault = vi.fn()
    const onClick = findNode(tree, el => el.props?.['aria-label'] === '回首頁')?.props?.onClick as
      ((e: { preventDefault: () => void }) => Promise<void>) | undefined
    if (!onClick) throw new Error('找不到 header 回首頁連結')
    await onClick({ preventDefault })
    return preventDefault
  }

  beforeEach(() => {
    mocks.navigate.mockReset()
    mocks.getUid.mockReset().mockResolvedValue('host')
    mocks.members = { data: [], error: null }
    mocks.from.mockReset().mockImplementation((table: string) => table === 'room_members'
      ? { select: () => Promise.resolve(mocks.members) }
      : { update: mocks.update })
  })

  it('點 header 回首頁不導航，改當場查房籍後開確認', async () => {
    mocks.members = { data: [row('room-1', 'ABC123', 'voting')], error: null }
    const tree = await mount()
    expect(textContent(tree)).not.toContain('離開房間？')
    const preventDefault = await clickHome(tree)
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.from).toHaveBeenCalledWith('room_members')
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.stateSetters[LEAVE_DIALOG]).toHaveBeenCalledWith({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 1, isHost: false }],
    })
    expect(mocks.stateSetters[LEAVE_CHECKING]).toHaveBeenCalledWith(true)
    expect(mocks.stateSetters[LEAVE_CHECKING]).toHaveBeenCalledWith(false)
  })

  // useRoom.ts:46 只在 r.data 為真時 setRoom——rooms 查詢失敗／Realtime 斷線時 room
  // 會停在過期物件。文案若讀它，lobby→voting 之後仍會承諾「可用邀請碼重新加入」
  it('文案用查回來的 status，不用 useRoom 的過期 room 快照', async () => {
    mocks.members = { data: [row('room-1', 'ABC123', 'voting'), row('room-1', 'ABC123', 'voting')], error: null }
    const tree = await mount() // useRoom 仍宣稱 status = 'lobby'
    await clickHome(tree)
    const target = mocks.stateSetters[LEAVE_DIALOG].mock.calls[0][0] as { rooms: { status: string }[] }
    expect(target.rooms[0].status).toBe('voting')
    const rendered = textContent(await mount(target))
    expect(rendered).toContain('你的投票會即刻作廢，候選盤面會重新計算')
    expect(rendered).not.toContain('之後可用邀請碼重新加入') // lobby 才有的承諾
  })

  // POST /api/leave 是全退不挑房：殘留房籍（舊房 leave 逾時後又建新房）也會被退掉
  it('殘留房籍一起列出，各有回房入口（leave 是全退）', async () => {
    mocks.members = {
      data: [row('room-1', 'ABC123', 'voting'), row('room-9', 'OLD999', 'lobby')],
      error: null,
    }
    const tree = await mount()
    await clickHome(tree)
    const target = mocks.stateSetters[LEAVE_DIALOG].mock.calls[0][0]
    const text = textContent(await mount(target))
    expect(text).toContain('你目前在 2 個房間裡，回首頁會一次全部離開')
    expect(text).toContain('房間 ABC123')
    expect(text).toContain('房間 OLD999')
    const rendered = await mount(target)
    expect(findNode(rendered, el => el.type === 'a' && textContent(el) === '回到 OLD999')?.props?.to)
      .toBe('/room/room-9')
  })

  it('房籍查詢失敗改用保守文案，不假裝知道後果', async () => {
    mocks.members = { data: null, error: { message: 'boom' } }
    const tree = await mount()
    await clickHome(tree)
    expect(mocks.stateSetters[LEAVE_DIALOG]).toHaveBeenCalledWith({ kind: 'unknown' })

    const text = textContent(await mount({ kind: 'unknown' }))
    expect(text).toContain('房間現況查不到')
    expect(text).not.toContain('可用邀請碼重新加入')
    expect(text).not.toContain('會直接被刪除')
  })

  it('查到房籍已消失：直接導航，不跳確認', async () => {
    mocks.members = { data: [], error: null }
    const tree = await mount()
    await clickHome(tree)
    expect(mocks.navigate).toHaveBeenCalledWith('/')
    expect(mocks.stateSetters[LEAVE_DIALOG]).not.toHaveBeenCalled()
  })

  // aria-busy 擋不住點擊；兩次點擊之間房籍會變（多分頁是 ADR-0007 承認的情境）
  it('晚到的舊「沒有房間」回應不得跳過剛開好的 dialog', async () => {
    let releaseFirst!: () => void
    const first = new Promise(resolve => {
      releaseFirst = () => resolve({ data: [], error: null })
    })
    const second = Promise.resolve({ data: [row('room-9', 'NEW999', 'lobby')], error: null })
    const queue: unknown[] = [first, second]
    mocks.from.mockImplementation((table: string) => table === 'room_members'
      ? { select: () => queue.shift() ?? second }
      : { update: mocks.update })

    const tree = await mount()
    const firstClick = clickHome(tree)
    const secondClick = clickHome(tree)
    await secondClick
    expect(mocks.stateSetters[LEAVE_DIALOG]).toHaveBeenCalledTimes(1)

    releaseFirst()
    await firstClick
    expect(mocks.navigate).not.toHaveBeenCalled() // 舊回應沒有繞過 dialog 直接離席
    expect(mocks.stateSetters[LEAVE_DIALOG]).toHaveBeenCalledTimes(1)
    expect(mocks.stateSetters[LEAVE_CHECKING].mock.calls).toEqual([[true], [true], [false]])
  })

  it('確認開啟時是有名稱的 modal dialog，取消與 Esc 都留在房間', async () => {
    const tree = await mount({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 2, isHost: false }],
    })
    const dialog = findNode(tree, el => el.props?.role === 'dialog')
    expect(dialog?.props?.['aria-modal']).toBe('true')
    expect(dialog?.props?.['aria-labelledby']).toBe('leave-title')

    const cancel = findButton(tree, '取消')
    if (!cancel.props?.onClick) throw new Error('找不到取消按鈕')
    await cancel.props.onClick()
    expect(mocks.stateSetters[LEAVE_DIALOG]).toHaveBeenCalledWith(null)

    const overlay = findNode(tree, el => typeof el.props?.onKeyDown === 'function')
    const onKeyDown = overlay!.props!.onKeyDown as (e: { key: string }) => void
    mocks.stateSetters[LEAVE_DIALOG].mockClear()
    onKeyDown({ key: 'Enter' })
    expect(mocks.stateSetters[LEAVE_DIALOG]).not.toHaveBeenCalled()
    onKeyDown({ key: 'Escape' })
    expect(mocks.stateSetters[LEAVE_DIALOG]).toHaveBeenCalledWith(null)
  })

  it('確認鍵是真正導航的連結，且帶「已確認」旗標避免首頁再問一次', async () => {
    const tree = await mount({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 2, isHost: false }],
    })
    const confirm = findNode(tree, el => el.type === 'a' && textContent(el) === '離開房間')
    expect(confirm?.props?.to).toBe('/')
    expect(confirm?.props?.state).toEqual({ leaveConfirmed: true })
    expect(confirm?.props?.onClick).toBeUndefined() // 未被攔截＝按下才真的離席
  })

  // fixed 遮罩擋得住指標，對 tab 順序毫無作用：背景整塊要 inert，且 dialog 不能在裡面
  it('dialog 開著時背景 inert，dialog 本身在 inert 子樹外', async () => {
    const closed = findNode(await mount(null), el => el.props?.className === 'min-h-screen')
    expect(closed?.props?.inert).toBe(false)

    const tree = await mount({
      kind: 'rooms',
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 2, isHost: false }],
    })
    const background = findNode(tree, el => el.props?.className === 'min-h-screen')
    expect(background?.props?.inert).toBe(true)
    expect(findNode(background, el => el.props?.role === 'dialog')).toBeUndefined()
    expect(findNode(tree, el => el.props?.role === 'dialog')).toBeDefined()
    // 背景真的含著會被鍵盤觸發的控制項——斷言不是空的
    expect(findNode(background, el => el.type === 'button')).toBeDefined()
  })
})

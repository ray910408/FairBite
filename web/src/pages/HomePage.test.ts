import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  // ref 依呼叫順序保存，跨 render 沿用、換 mount 才清空——「同一次 mount 只做一次
  // 離席決策」的守衛就靠 ref，每次 render 發新物件會讓它永遠測不到
  refIndex: 0,
  refs: [] as { current: unknown }[],
  effects: [] as Array<() => void | (() => void)>,
  getUid: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  navigate: vi.fn(),
  saveLastDeparture: vi.fn(),
  leaveRooms: vi.fn(),
  fetchLeaveRooms: vi.fn(),
  locationState: null as unknown,
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
    useRef: (initial: unknown) => (mocks.refs[mocks.refIndex++] ??= { current: initial }),
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
    useCallback: (fn: unknown) => fn,
  }
})

vi.mock('react-router-dom', () => ({
  Link: 'a',
  useNavigate: () => mocks.navigate,
  // state 掛在 history entry 上（不是掛在一次導覽上）：重整與上一頁都會把它還原，
  // 所以這裡拿 mocks.locationState 當那筆 entry，replace 才有東西可以蓋掉
  useLocation: () => ({ pathname: '/', state: mocks.locationState }),
}))

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signOut: vi.fn() }, rpc: mocks.rpc, from: mocks.from },
}))
vi.mock('../lib/uid', () => ({ getUid: mocks.getUid }))
vi.mock('../lib/api', () => ({ leaveRooms: mocks.leaveRooms }))
// 房籍查詢本體（lib/roomMembership）由 HistoryPage.test.ts 從頁面端整條打過，這裡只驗分支
vi.mock('../lib/roomMembership', () => ({ fetchLeaveRooms: mocks.fetchLeaveRooms }))

vi.mock('../lib/departure', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/departure')>()
  return { ...actual, saveLastDeparture: mocks.saveLastDeparture }
})

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

type NodeLike = { type?: unknown; props?: Record<string, unknown> }

// findButton 只認 <button>；dialog 容器要用述詞找（比照 HistoryPage.test.ts）
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

function findButtonAnywhere(tree: unknown, label: string) {
  const button = findButton(tree, label)
  if (!button.type) throw new Error(`找不到按鈕：${label}`)
  return button as { props: { disabled?: boolean } }
}

function findSections(node: unknown, out: ElementLike[] = []): ElementLike[] {
  if (Array.isArray(node)) {
    for (const child of node) findSections(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  const element = node as ElementLike
  if (element.type === 'section') out.push(element)
  findSections(element.props?.children, out)
  return out
}

async function clickCreateRoom() {
  const { default: HomePage } = await import('./HomePage')
  const tree = HomePage()
  const button = findButton(tree, '建立房間')
  if (!button.props?.onClick) throw new Error('找不到建立房間按鈕')
  await button.props.onClick()
}

describe('HomePage persistRoom', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.refIndex = 0
    mocks.refs = []
    mocks.stateValues = [
      '', '', '', '', { lat: 25.0478, lng: 121.517, label: '台北車站' },
      'now', '', '', false, '', {}, [],
    ]
    mocks.getUid.mockReset()
    mocks.rpc.mockReset().mockResolvedValue({ data: 'room-1', error: null })
    mocks.from.mockReset().mockImplementation(() => {
      throw new Error('已套用偏好時不應查表')
    })
    mocks.navigate.mockReset()
    mocks.saveLastDeparture.mockReset()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '1'),
      setItem: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('以發起建房時的 uid 儲存出發點，不受 pending 期間換帳號影響', async () => {
    mocks.getUid
      .mockResolvedValueOnce('creator')
      .mockResolvedValue('replacement')

    await clickCreateRoom()

    expect(mocks.getUid.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0])
    expect(mocks.saveLastDeparture).toHaveBeenCalledWith('creator', {
      lat: 25.0478, lng: 121.517, label: '台北車站',
    })
  })

  it('發起時未登入便不建立房間', async () => {
    mocks.getUid.mockResolvedValue(null)

    await clickCreateRoom()

    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.saveLastDeparture).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe('HomePage 錯誤就地顯示（QA ISSUE-003）', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.refIndex = 0
    mocks.refs = []
    mocks.getUid.mockReset().mockResolvedValue('creator')
    mocks.rpc.mockReset()
    mocks.from.mockReset()
    mocks.navigate.mockReset()
    mocks.saveLastDeparture.mockReset()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => '1'), setItem: vi.fn() })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('自訂時間未選完整就按建立房間：不打 API', async () => {
    mocks.stateValues = [
      '', '', '', '', { lat: 25.0478, lng: 121.517, label: '台北車站' },
      'custom', '', '', false, '', {}, [],
    ]
    await clickCreateRoom()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('建房錯誤渲染在建立房間的卡片內，不在頁尾', async () => {
    mocks.stateValues = [
      '', '請選擇完整的用餐時間', '', '', { lat: 25.0478, lng: 121.517, label: '台北車站' },
      'custom', '', '', false, '', {}, [],
    ]
    const { default: HomePage } = await import('./HomePage')
    const sections = findSections(HomePage())
    expect(textContent(sections[0])).toContain('請選擇完整的用餐時間')
    expect(textContent(sections[1])).not.toContain('請選擇完整的用餐時間')
  })
})

// state 索引：12 leavePending / 13 leaveTarget（新 state 只能接在它們後面）
const PENDING = 12
const TARGET = 13
const inRoom = { id: 'room-1', code: 'ABC123', status: 'lobby', memberCount: 2, isHost: false }

function stubSuggestionQueries() {
  mocks.from.mockReset().mockReturnValue({
    select: vi.fn().mockReturnValue({
      eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null }) }),
      order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [] }) }),
      lte: vi.fn().mockResolvedValue({ data: [] }),
    }),
  })
}

describe('HomePage 退房閘門', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.refIndex = 0
    mocks.refs = []
    mocks.stateValues = []
    mocks.stateSetters = []
    mocks.effects = []
    mocks.getUid.mockReset().mockResolvedValue('user-1')
    mocks.leaveRooms.mockReset().mockResolvedValue(undefined)
    mocks.fetchLeaveRooms.mockReset().mockResolvedValue([])
    mocks.locationState = null
    stubSuggestionQueries()
  })

  it('leave 未 settle 前建立房間與加入都禁用', async () => {
    mocks.stateValues = []
    mocks.stateValues[4] = { lat: 25.0478, lng: 121.517 }
    const { default: HomePage } = await import('./HomePage')
    const tree = HomePage()
    expect(findButtonAnywhere(tree, '建立房間').props.disabled).toBe(true)
    expect(findButtonAnywhere(tree, '加入').props.disabled).toBe(true)
  })

  it('leave settle 後兩鈕解禁', async () => {
    mocks.stateValues = []
    mocks.stateValues[4] = { lat: 25.0478, lng: 121.517 }
    mocks.stateValues[PENDING] = false
    const { default: HomePage } = await import('./HomePage')
    const tree = HomePage()
    expect(findButtonAnywhere(tree, '建立房間').props.disabled).toBe(false)
    expect(findButtonAnywhere(tree, '加入').props.disabled).toBe(false)
  })
})

// 登出沒有閘門就是幽靈成員的來源：查房籍還在飛、或確認 dialog 開著時登出，App.tsx 的
// auth listener 會卸載 HomePage，doLeave() 永遠不會執行，伺服器端房籍留著——那個人的
// 條件與票繼續約束房間盤面。原本 mount 是無條件立刻送 leaveRooms()，窗口只有毫秒級；
// 改成「先查再問」之後窗口被拉長到「等一個人做決定」。
describe('HomePage 登出閘門', () => {
  beforeEach(() => {
    mocks.refs = []
    mocks.effects = []
    mocks.navigate.mockReset()
    mocks.getUid.mockReset().mockResolvedValue('user-1')
    mocks.leaveRooms.mockReset().mockResolvedValue(undefined)
    mocks.fetchLeaveRooms.mockReset().mockResolvedValue([])
    mocks.locationState = null
    stubSuggestionQueries()
  })

  async function render(pending: unknown, target: unknown = null) {
    mocks.stateIndex = 0
    mocks.refIndex = 0
    mocks.refs = []
    mocks.stateValues = []
    mocks.stateValues[4] = { lat: 25.0478, lng: 121.517 }
    mocks.stateValues[PENDING] = pending
    mocks.stateValues[TARGET] = target
    mocks.stateSetters = []
    mocks.effects = []
    const { default: HomePage } = await import('./HomePage')
    return HomePage()
  }

  it('查房籍未 settle 前登出禁用（此時登出＝伺服器端留下幽靈房籍）', async () => {
    expect(findButtonAnywhere(await render(true), '登出').props.disabled).toBe(true)
  })

  it('離席確認 dialog 開著時登出仍禁用（使用者還沒決定要不要退房）', async () => {
    const tree = await render(true, { kind: 'rooms', rooms: [inRoom] })
    expect(findButtonAnywhere(tree, '登出').props.disabled).toBe(true)
  })

  it('leave settle 後登出解禁', async () => {
    expect(findButtonAnywhere(await render(false), '登出').props.disabled).toBe(false)
  })

  // 這條是本輪最容易被弄壞的地方：把登出掛上 leavePending 之後，任何讓 leavePending
  // 永遠停在 true 的路徑都會把使用者鎖死在首頁（比幽靈房籍更糟）。懸掛的連線就是那條
  // 路徑——fetchLeaveRooms 的 5 秒逾時把它併進「查詢失敗」（roomMembership.test.ts
  // 釘住逾時本身），這裡把逾時之後的後半段走完：dialog 一定出得來，按下去一定解禁。
  it('查詢逾時（回 null）：保守 dialog 出得來，按離開房間後登出鍵回到可用', async () => {
    mocks.fetchLeaveRooms.mockResolvedValue(null) // 逾時與查詢失敗同一條路徑
    const mounted = await render(true)
    for (const fn of mocks.effects) fn()
    await vi.waitFor(() =>
      expect(mocks.stateSetters[TARGET]).toHaveBeenCalledWith({ kind: 'unknown' }))
    expect(findButtonAnywhere(mounted, '登出').props.disabled).toBe(true) // 決定前仍鎖著

    const withDialog = await render(true, { kind: 'unknown' })
    const leave = findButton(withDialog, '離開房間')
    if (!leave.props?.onClick) throw new Error('找不到離開房間按鈕')
    await leave.props.onClick()
    await vi.waitFor(() => expect(mocks.stateSetters[PENDING]).toHaveBeenCalledWith(false))

    // 閘門解除後的那次繪製：登出鍵確實回到可用——沒有永久禁用這條路
    expect(findButtonAnywhere(await render(false), '登出').props.disabled).toBe(false)
  })
})

// ADR-0007（2026-08-16 修訂）：mount 是所有繞過路徑的咽喉，但不再靜默退房
describe('HomePage mount 離席確認', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.refIndex = 0
    mocks.refs = []
    mocks.stateValues = []
    mocks.stateSetters = []
    mocks.effects = []
    mocks.getUid.mockReset().mockResolvedValue('user-1')
    mocks.leaveRooms.mockReset().mockResolvedValue(undefined)
    mocks.fetchLeaveRooms.mockReset().mockResolvedValue([])
    mocks.locationState = null
    // nav(pathname, { replace: true, state: null }) 的真實效果就是把那筆 entry 的
    // state 蓋掉——照這樣模擬，之後回到同一筆 entry 才會真的讀不到旗標
    mocks.navigate.mockReset().mockImplementation(
      (_to: string, opts?: { replace?: boolean; state?: unknown }) => {
        if (opts?.replace) mocks.locationState = opts.state ?? null
      })
    stubSuggestionQueries()
  })

  async function runMount() {
    const { default: HomePage } = await import('./HomePage')
    HomePage()
    for (const fn of mocks.effects) fn()
  }

  function remount() { // 上一頁回到同一筆 entry：新的 mount，但 entry 還是那一筆
    mocks.stateIndex = 0
    mocks.refIndex = 0
    mocks.refs = []
    mocks.stateSetters = []
    mocks.effects = []
    return runMount()
  }

  it('查到房間不自動退房，改開離席確認', async () => {
    mocks.fetchLeaveRooms.mockResolvedValue([inRoom])
    await runMount()
    await vi.waitFor(() =>
      expect(mocks.stateSetters[TARGET]).toHaveBeenCalledWith({ kind: 'rooms', rooms: [inRoom] }))
    expect(mocks.leaveRooms).not.toHaveBeenCalled()
    expect(mocks.stateSetters[PENDING]).not.toHaveBeenCalled() // 閘門不得在使用者決定前解除
  })

  // room_members 就是權威（RLS 只回自己的列）：回空代表真的沒房可退，不必打 /api/leave
  it('查到沒有房間：不退房，直接解除 leavePending', async () => {
    mocks.fetchLeaveRooms.mockResolvedValue([])
    await runMount()
    await vi.waitFor(() => expect(mocks.stateSetters[PENDING]).toHaveBeenCalledWith(false))
    expect(mocks.leaveRooms).not.toHaveBeenCalled()
    expect(mocks.stateSetters[TARGET]).not.toHaveBeenCalled()
  })

  // 退房不可逆：查不到現況就不准替使用者按下去
  it('房籍查詢失敗不靜默退房，改開保守 dialog', async () => {
    mocks.fetchLeaveRooms.mockResolvedValue(null)
    await runMount()
    await vi.waitFor(() =>
      expect(mocks.stateSetters[TARGET]).toHaveBeenCalledWith({ kind: 'unknown' }))
    expect(mocks.leaveRooms).not.toHaveBeenCalled()
    expect(mocks.stateSetters[PENDING]).not.toHaveBeenCalled()
  })

  // RoomPage／HistoryPage 的離席確認已經把同一份後果講完了，首頁再問一次＝連跳兩張。
  // 但旗標掛在 history entry 上（重整與上一頁都會還原），用完必須當場 replace 掉。
  it('房內已確認過（帶 leaveConfirmed）就直接退房，不再查也不再問，並當場消耗旗標', async () => {
    mocks.locationState = { leaveConfirmed: true }
    mocks.fetchLeaveRooms.mockResolvedValue([inRoom])
    await runMount()
    await vi.waitFor(() => expect(mocks.leaveRooms).toHaveBeenCalledTimes(1))
    expect(mocks.navigate).toHaveBeenCalledWith('/', { replace: true, state: null })
    expect(mocks.locationState).toBeNull() // entry 上已經沒有旗標
    expect(mocks.fetchLeaveRooms).not.toHaveBeenCalled()
    expect(mocks.stateSetters[TARGET]).not.toHaveBeenCalled()
    await vi.waitFor(() => expect(mocks.stateSetters[PENDING]).toHaveBeenCalledWith(false))
  })

  // 這條是本輪 review 的核心：旗標若沒被消耗，「退房 → 在首頁建新房 → 上一頁」
  // 會讀回同一筆 entry 的旗標，直接靜默退掉新房——正是 mount 攔截要防的那個繞過
  it('旗標消耗後回到同一筆 entry：不再直接退房，改走查房籍→開 dialog', async () => {
    mocks.locationState = { leaveConfirmed: true }
    mocks.fetchLeaveRooms.mockResolvedValue([inRoom])
    await runMount() // 房內確認過的那一次：直接退房並消耗旗標
    await vi.waitFor(() => expect(mocks.leaveRooms).toHaveBeenCalledTimes(1))

    mocks.leaveRooms.mockClear()
    mocks.fetchLeaveRooms.mockClear()
    await remount() // 上一頁回到同一筆 entry
    await vi.waitFor(() =>
      expect(mocks.stateSetters[TARGET]).toHaveBeenCalledWith({ kind: 'rooms', rooms: [inRoom] }))
    expect(mocks.fetchLeaveRooms).toHaveBeenCalled()
    expect(mocks.leaveRooms).not.toHaveBeenCalled() // 新建的房沒有被靜默退掉
  })

  // 消耗旗標的 replace 會讓 location 換新物件、effect 相依變動而重跑；此時 state 已是
  // null，沒有 ref 守衛就會掉進 else 分支去查房籍，在 doLeave() 還在飛的時候開一張 dialog。
  // 同一次 mount 的重繪：refs 不清空（remount 才清），才測得到那道守衛。
  it('消耗旗標造成的 effect 重跑不會再走查房籍那條路', async () => {
    mocks.locationState = { leaveConfirmed: true }
    mocks.fetchLeaveRooms.mockResolvedValue([inRoom])
    await runMount()
    expect(mocks.locationState).toBeNull() // 旗標已消耗

    mocks.stateIndex = 0
    mocks.refIndex = 0
    mocks.stateSetters = []
    mocks.effects = []
    await runMount() // 同一次 mount 的重繪 + effect 重跑

    await vi.waitFor(() => expect(mocks.leaveRooms).toHaveBeenCalledTimes(1))
    expect(mocks.fetchLeaveRooms).not.toHaveBeenCalled()
    expect(mocks.stateSetters[TARGET]).not.toHaveBeenCalled()
  })
})

describe('HomePage 離席確認 dialog', () => {
  beforeEach(() => {
    mocks.stateSetters = []
    mocks.refs = []
    mocks.effects = []
    mocks.navigate.mockReset()
    mocks.getUid.mockReset().mockResolvedValue('user-1')
    mocks.leaveRooms.mockReset().mockResolvedValue(undefined)
    mocks.fetchLeaveRooms.mockReset().mockResolvedValue([])
    mocks.locationState = null
    stubSuggestionQueries()
  })

  async function render(target: unknown) {
    mocks.stateIndex = 0
    mocks.refIndex = 0
    mocks.stateValues = []
    mocks.stateValues[4] = { lat: 25.0478, lng: 121.517 }
    mocks.stateValues[TARGET] = target
    mocks.stateSetters = []
    const { default: HomePage } = await import('./HomePage')
    return HomePage()
  }

  // 使用者還沒決定要不要退房，此時建房正是那個競態（晚到的全退會誤刪新房）
  it('dialog 開著時建房與加入維持禁用', async () => {
    const tree = await render({ kind: 'rooms', rooms: [inRoom] })
    expect(findButtonAnywhere(tree, '建立房間').props.disabled).toBe(true)
    expect(findButtonAnywhere(tree, '加入').props.disabled).toBe(true)
  })

  it('有名稱的 modal dialog，控制項在捲動區外', async () => {
    const tree = await render({ kind: 'rooms', rooms: [inRoom] })
    const dialog = findNode(tree, el => el.props?.role === 'dialog')
    expect(dialog?.props?.['aria-modal']).toBe('true')
    expect(dialog?.props?.['aria-labelledby']).toBe('leave-title')
    expect(textContent(tree)).toContain('你還在房間 ABC123 裡')
    expect(textContent(tree)).toContain('你若是最後一位成員，房間會直接被刪除')
  })

  it('確認離開才呼叫 leaveRooms，settle 後解除閘門', async () => {
    const tree = await render({ kind: 'rooms', rooms: [inRoom] })
    const leave = findButton(tree, '離開房間')
    if (!leave.props?.onClick) throw new Error('找不到離開房間按鈕')
    await leave.props.onClick()
    expect(mocks.stateSetters[TARGET]).toHaveBeenCalledWith(null)
    // api.ts 走動態 import（不進首屏 bundle），呼叫不同步發生
    await vi.waitFor(() => expect(mocks.leaveRooms).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(mocks.stateSetters[PENDING]).toHaveBeenCalledWith(false))
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('取消（回到房間）導回房間且不退房', async () => {
    const tree = await render({ kind: 'rooms', rooms: [inRoom] })
    const back = findButton(tree, '回到房間')
    if (!back.props?.onClick) throw new Error('找不到回到房間按鈕')
    await back.props.onClick()
    expect(mocks.navigate).toHaveBeenCalledWith('/room/room-1')
    expect(mocks.leaveRooms).not.toHaveBeenCalled()
  })

  // leave 是全退（POST /api/leave 不挑房），每個房籍都要講、都要有回房入口
  it('多房籍：各房後果分別列出，各給一個回房入口', async () => {
    const tree = await render({
      kind: 'rooms',
      rooms: [
        { id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1, isHost: true },
        { id: 'room-2', code: 'BBB222', status: 'decided', memberCount: 3, isHost: true },
      ],
    })
    const text = textContent(tree)
    expect(text).toContain('你還在 2 個房間裡')
    expect(text).toContain('邀請碼 AAA111 會跟著失效') // lobby 單人
    expect(text).toContain('抽中的結果之後只能在「足跡」查看') // decided 多人
    expect(findButton(tree, '回到房間').type).toBeUndefined() // 不替使用者猜要回哪一間
    const back = findButton(tree, '回到 BBB222')
    if (!back.props?.onClick) throw new Error('找不到回到 BBB222 按鈕')
    await back.props.onClick()
    expect(mocks.navigate).toHaveBeenCalledWith('/room/room-2')
  })

  it('查詢失敗的保守 dialog：不講具體後果，也不給猜的回房入口', async () => {
    const tree = await render({ kind: 'unknown' })
    const text = textContent(tree)
    expect(text).toContain('房間現況查不到')
    expect(text).not.toContain('可用邀請碼重新加入')
    expect(text).not.toContain('會直接被刪除')
    expect(findButton(tree, '回到房間').type).toBeUndefined()
    expect(findButton(tree, '重新整理再試').props?.onClick).toBeTypeOf('function')
    expect(findButton(tree, '離開房間').props?.onClick).toBeTypeOf('function')
  })

  it('沒有房籍就不渲染 dialog', async () => {
    expect(textContent(await render(null))).not.toContain('你還在房間裡')
  })

  // fixed 遮罩擋得住指標，對 tab 順序毫無作用：沒有 inert，鍵盤可以 tab 到背景的
  // 「建立房間」按 Enter，繞過還沒決定的退房
  it('dialog 開著時背景 inert，dialog 本身在 inert 子樹外', async () => {
    const closed = findNode(await render(null), el => el.props?.className === 'min-h-screen')
    expect(closed?.props?.inert).toBe(false)

    const tree = await render({ kind: 'rooms', rooms: [inRoom] })
    const background = findNode(tree, el => el.props?.className === 'min-h-screen')
    expect(background?.props?.inert).toBe(true)
    expect(findNode(background, el => el.props?.role === 'dialog')).toBeUndefined()
    expect(findNode(tree, el => el.props?.role === 'dialog')).toBeDefined()
    // 背景真的含著會被鍵盤觸發的控制項——斷言不是空的
    expect(findButton(background, '建立房間').type).toBe('button')
  })
})

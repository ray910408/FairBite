import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  useRoom: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
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
}))

vi.mock('../hooks/useRoom', () => ({ useRoom: mocks.useRoom }))

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

// QA：房間頁左上 logo 按下去靜默送出 leave（ADR-0007 回首頁＝離席），要先確認
describe('回首頁離席確認', () => {
  const LEAVE_STATE = 9 // useState 呼叫順序中的 leaveOpen；新 state 只能接在它後面

  // 末位退房無條件刪房（server/leave.go）——文案依人數分歧，預設多人房
  function mount(status: string, leaveOpen: boolean, memberCount = 2,
    overrides: Record<string, unknown> = {}) {
    mocks.stateIndex = 0
    mocks.stateValues = [false, '', '', false, false, '', '', false, false, leaveOpen]
    mocks.stateSetters = []
    mocks.useRoom.mockReset().mockReturnValue({
      room: {
        id: 'room-1', code: 'ABC123', host_id: 'host', status,
        exploration: 'balanced', meal_time: null, cuisine_filter: false,
      },
      members: Array.from({ length: memberCount }, (_, i) => ({
        room_id: 'room-1', user_id: i === 0 ? 'host' : `user-${i}`, budget_max: 800,
        cuisines: [], dietary: [], max_distance_m: 1000, transport: 'walking', ready: false,
        profiles: { display_name: i === 0 ? '房主' : `成員${i}` },
      })),
      membersStale: false,
      candidates: [], draw: null, myUserId: 'host', connected: true,
      notFound: false, loadError: false, refetch: vi.fn(),
      toggleVote: vi.fn(), myVote: () => null, ups: new Map(), vetoesRemaining: 2,
      ...overrides,
    })
    return renderRoomPage()
  }

  it('點 header 回首頁不導航，改開啟確認', async () => {
    const tree = await mount('voting', false)
    expect(textContent(tree)).not.toContain('離開房間？')
    const link = findNode(tree, el => el.props?.['aria-label'] === '回首頁')
    const preventDefault = vi.fn()
    const onClick = link?.props?.onClick as ((e: { preventDefault: () => void }) => void) | undefined
    if (!onClick) throw new Error('找不到 header 回首頁連結')
    onClick({ preventDefault })
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.stateSetters[LEAVE_STATE]).toHaveBeenCalledWith(true)
  })

  it('確認開啟時是有名稱的 modal dialog，取消與 Esc 都留在房間', async () => {
    const tree = await mount('voting', true)
    const dialog = findNode(tree, el => el.props?.role === 'dialog')
    expect(dialog?.props?.['aria-modal']).toBe('true')
    expect(dialog?.props?.['aria-labelledby']).toBe('leave-title')

    const cancel = findButton(tree, '取消')
    if (!cancel.props?.onClick) throw new Error('找不到取消按鈕')
    await cancel.props.onClick()
    expect(mocks.stateSetters[LEAVE_STATE]).toHaveBeenCalledWith(false)

    const overlay = findNode(tree, el => typeof el.props?.onKeyDown === 'function')
    const onKeyDown = overlay!.props!.onKeyDown as (e: { key: string }) => void
    mocks.stateSetters[LEAVE_STATE].mockClear()
    onKeyDown({ key: 'Enter' })
    expect(mocks.stateSetters[LEAVE_STATE]).not.toHaveBeenCalled()
    onKeyDown({ key: 'Escape' })
    expect(mocks.stateSetters[LEAVE_STATE]).toHaveBeenCalledWith(false)
  })

  it('確認鍵才是真正導航到首頁的連結', async () => {
    const tree = await mount('voting', true)
    const confirm = findNode(tree, el => el.type === 'a' && textContent(el) === '離開房間')
    expect(confirm?.props?.to).toBe('/')
    expect(confirm?.props?.onClick).toBeUndefined() // 未被攔截＝按下才真的離席
  })

  it('decided 的後果文案與 lobby 不同', async () => {
    const lobby = textContent(await mount('lobby', true))
    expect(lobby).toContain('之後可用邀請碼重新加入')
    expect(lobby).not.toContain('「足跡」查看')

    const decided = textContent(await mount('decided', true))
    expect(decided).toContain('無法用邀請碼重新加入')
    expect(decided).toContain('抽中的結果之後只能在「足跡」查看')
    expect(decided).toContain('你若是最後一位成員，房間會直接被刪除')
  })

  // 末位退房的 delete from rooms 不看 status（server/leave.go:106-111）：
  // 單人 lobby 房必被刪、邀請碼必失效，不得承諾可重加入
  it('單人 lobby 不承諾可重加入，多人才承諾', async () => {
    const alone = textContent(await mount('lobby', true, 1))
    expect(alone).not.toContain('可用邀請碼重新加入')
    expect(alone).toContain('你是房間裡唯一的人，離開後這個房間會直接刪除')
    expect(alone).toContain('邀請碼 ABC123 會跟著失效')

    const shared = textContent(await mount('lobby', true, 2))
    expect(shared).toContain('之後可用邀請碼重新加入')
    expect(shared).toContain('你若是最後一位成員，房間會直接被刪除')
  })

  // 成員查詢失敗時 useRoom 不覆寫 members（停在 []），房間卻照常 render——
  // 0 只可能是「沒載成功」，不得當成單人講死話
  it('成員沒載成功（members 空）時退回不可判定的條件句', async () => {
    const alone = textContent(await mount('lobby', true, 0))
    expect(alone).not.toContain('你是房間裡唯一的人')
    expect(alone).not.toContain('邀請碼 ABC123 會跟著失效')
    expect(alone).toContain('你若是最後一位成員，房間會直接被刪除')
    expect(alone).toContain('只要房間還在（你不是最後一位），之後仍可用邀請碼重新加入')
  })

  it('單人房在 voting／decided 也用「確定會刪除」而非條件句', async () => {
    for (const status of ['voting', 'decided']) {
      const alone = textContent(await mount(status, true, 1))
      expect(alone).toContain('你是房間裡唯一的人，離開後這個房間會直接刪除')
      expect(alone).not.toContain('你若是最後一位成員')
      expect(alone).not.toContain('可用邀請碼重新加入')
    }
  })

  // 單人房刪完房就 return，走不到 rescoreRoom（server/leave.go）——不得承諾重算
  it('單人 candidates／voting 不承諾重新分割或重新計算', async () => {
    const candidates = textContent(await mount('candidates', true, 1))
    expect(candidates).not.toContain('重新分割')
    expect(candidates).not.toContain('退出重算')
    expect(candidates).toContain('你是房間裡唯一的人，離開後這個房間會直接刪除')

    const voting = textContent(await mount('voting', true, 1))
    expect(voting).not.toContain('重新計算')
    expect(voting).not.toContain('盤面')
    expect(voting).toContain('你的票和整份候選名單會跟著刪除')
  })

  // 房主退出＝移交給最早加入者（ADR-0007、leave.go 的 update rooms set host_id）
  it('多人房的房主看得到移交敘述，一般成員看不到', async () => {
    const host = textContent(await mount('lobby', true, 2))
    expect(host).toContain('你是房主：離開後房主身分會移交給其餘成員中最早加入的人')
    expect(host).toContain('你重新加入也不會拿回房主權限')

    const member = textContent(await mount('lobby', true, 2, { myUserId: 'user-1' }))
    expect(member).not.toContain('移交')
  })

  it('單人房的房主不講移交（沒有人可以繼任）', async () => {
    expect(textContent(await mount('lobby', true, 1))).not.toContain('移交')
  })

  // uid 還沒載回來時 isHost 會恆為 false，那是猜的——退回條件句
  it('myUserId 未載回時用「你若是房主」的條件句', async () => {
    const text = textContent(await mount('lobby', true, 2, { myUserId: '' }))
    expect(text).toContain('你若是房主，房主身分會移交給')
  })

  // useRoom 成員查詢失敗時 members 停在舊值（可能是非空的過期快照，membersStale）——
  // 期間有人加入／離開，拿它講「你是唯一的人／房間會被刪除」就是錯的
  it('membersStale 時即使 members 非空也退回不可判定的條件句', async () => {
    const stale = textContent(await mount('lobby', true, 1, { membersStale: true }))
    expect(stale).not.toContain('你是房間裡唯一的人')
    expect(stale).not.toContain('邀請碼 ABC123 會跟著失效')
    expect(stale).toContain('你若是最後一位成員，房間會直接被刪除')
    expect(stale).toContain('只要房間還在（你不是最後一位），之後仍可用邀請碼重新加入')
  })
})

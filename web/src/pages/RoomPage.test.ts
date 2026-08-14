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
  })

  it('startingVoting=true 時投票鈕 disabled 顯示「處理中…」', async () => {
    mocks.stateValues[8] = true
    mocks.useRoom.mockReturnValue(roomState({ room: { ...lobbyRoom, status: 'candidates' } }))
    const tree = await renderRoomPage()
    const btn = findButton(tree, '處理中…') as { props?: { disabled?: boolean } }
    expect(btn.props?.disabled).toBe(true)
  })
})

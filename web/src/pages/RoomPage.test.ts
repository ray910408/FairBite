import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import CandidateList from '../components/CandidateList'
import RelocationPanel from '../components/RelocationPanel'
import ShortlistVotePanel from '../components/ShortlistVotePanel'
import type { CandidateRow } from '../lib/types'

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
  getSession: vi.fn(),
  searchRoom: vi.fn(),
  editConditions: vi.fn(),
  confirmDraw: vi.fn(),
  redrawRoom: vi.fn(),
  drawRoom: vi.fn(),
  chooseLocation: vi.fn(async () => null),
  startVoting: vi.fn(async (): Promise<string | null> => null),
  cancelShortlist: vi.fn(async (): Promise<string | null> => null),
  voteShortlist: vi.fn(async (): Promise<string | null> => null),
  voteLocation: vi.fn(async (): Promise<string | null> => null),
  pendingLeave: vi.fn<() => Promise<void> | null>(() => null),
  members: {} as { data?: unknown; error?: unknown },
  effects: [] as Array<() => void | (() => void)>,
  // 預設每次 render 都拿新 ref；要跨 render 保留（例如比對前後兩次的 status）時設成 []
  refs: undefined as Array<{ current: unknown }> | undefined,
  refIndex: 0,
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
    useRef: (initial: unknown) => {
      if (!mocks.refs) return { current: initial }
      const index = mocks.refIndex++
      return (mocks.refs[index] ??= { current: initial })
    },
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
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
    auth: { getSession: mocks.getSession },
  },
}))

vi.mock('../lib/api', () => ({
  searchRoom: mocks.searchRoom,
  editConditions: mocks.editConditions,
  confirmDraw: mocks.confirmDraw,
  redrawRoom: mocks.redrawRoom,
  drawRoom: mocks.drawRoom,
  chooseLocation: mocks.chooseLocation,
  startVoting: mocks.startVoting,
  cancelShortlist: mocks.cancelShortlist,
  voteShortlist: mocks.voteShortlist,
  voteLocation: mocks.voteLocation,
  pendingLeave: mocks.pendingLeave,
}))

type ElementLike = {
  type?: unknown
  props?: { children?: unknown; disabled?: boolean; onClick?: () => void | Promise<void>; className?: string }
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

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>(r => { resolve = r })
  return { promise, resolve }
}

async function renderRoomPage() {
  const { default: RoomPage } = await import('./RoomPage')
  mocks.refIndex = 0
  return RoomPage()
}

type ConfirmAskLike = { title: string; body: string; confirmLabel: string; onConfirm: () => Promise<void> }

// 站內確認框：觸發鈕只開框（setConfirmAsk＝頁面第 19 個 state），回傳框上「確定」要跑的內容。
// setter 要在 findButton 之前抓：展開子元件時它們的 useState 會覆寫 stateSetters
function openConfirm(tree: unknown, label: string, setConfirmAsk: ReturnType<typeof vi.fn>,
  trigger: { focus: () => void } = { focus: vi.fn() }): ConfirmAskLike {
  const click = findButton(tree, label).props?.onClick as ((e: unknown) => void) | undefined
  if (!click) throw new Error(`找不到${label}`)
  click({ currentTarget: trigger })
  expect(setConfirmAsk).toHaveBeenCalledOnce()
  return setConfirmAsk.mock.calls[0][0] as ConfirmAskLike
}

// 關閉 dialog 後的焦點還原走 rAF（背景整塊 inert，要等移除它的那次 commit 才聚焦得到）
// ——node 測試環境沒有這個瀏覽器全域，補一個等價的排程器
beforeEach(() => vi.stubGlobal('requestAnimationFrame', (cb: () => void) => setTimeout(cb, 0)))
afterEach(() => { vi.unstubAllGlobals(); mocks.refs = undefined })

describe('RoomPage meal_time draft intent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.stateIndex = 0
    mocks.stateValues = [false, '', '', false, false, '', '']
    mocks.stateSetters = []
    mocks.effects = []
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

describe('RoomPage voting controls', () => {
  it('同店 up/veto 各自 pressed；額度用盡仍可收回 veto', () => {
    const rows: CandidateRow[] = [{
      room_id: 'room-1', restaurant_id: 'r1', status: 'kept', probability: 1,
      weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
      restaurants: { name: '測試餐廳', lat: 25, lng: 121, place_id: 'test', source: 'mock' },
    }]
    const tree = CandidateList({ rows, voting: {
      hasMyVote: () => true, ups: { r1: 1 }, vetoesRemaining: 0, onToggle: vi.fn(),
    } } as never)
    const up = findNode(tree, el => el.type === 'button' && textContent(el) === '贊成（1）')
    const veto = findNode(tree, el => el.type === 'button' && textContent(el) === '否決')
    expect(up?.props?.['aria-pressed']).toBe(true)
    expect(veto?.props?.['aria-pressed']).toBe(true)
    expect(veto?.props?.disabled).toBe(false)
  })

  it('投票中順序固定：贊成改變機率不重排，被否決的店留在原位、可就地收回', () => {
    const row = (id: string, probability: number | null, extra: Partial<CandidateRow> = {}): CandidateRow => ({
      room_id: 'room-1', restaurant_id: id, status: 'kept', probability,
      weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
      restaurants: { name: `店${id}`, lat: 25, lng: 121, place_id: id, source: 'mock' }, ...extra,
    })
    const onToggle = vi.fn()
    const voting = { hasMyVote: (rid: string, kind: 'up' | 'veto') => kind === 'veto' && rid === 'b',
      ups: {}, vetoesRemaining: 1, onToggle }
    const rowNames = (tree: unknown): string[] => {
      const out: string[] = []
      const walk = (n: unknown) => {
        if (Array.isArray(n)) return n.forEach(walk)
        if (!n || typeof n !== 'object') return
        const el = n as NodeLike
        const id = el.props?.['data-testid']
        if (id === 'candidate-row' || id === 'vetoed-row') out.push(textContent(el).match(/店\w/)![0])
        else walk(el.props?.children)
      }
      walk(tree)
      return out
    }
    mocks.refs = [] // 同一個元件實例的兩次 render：順序記在 ref 裡
    mocks.refIndex = 0
    expect(rowNames(CandidateList({ rows: [row('a', 0.3), row('b', 0.5), row('c', 0.2)], voting }))).toEqual(['店b', '店a', '店c'])

    mocks.refIndex = 0
    const tree = CandidateList({ rows: [row('a', 0.9), row('c', 0.1), row('b', null, {
      status: 'excluded', exclusion_kinds: ['veto'], exclusion_reason: '遭 小明 否決（可收回）' })], voting })
    expect(rowNames(tree)).toEqual(['店b', '店a', '店c'])
    const vetoed = findNode(tree, el => el.props?.['data-testid'] === 'vetoed-row')
    expect(textContent(vetoed)).toContain('遭 小明 否決（可收回）')
    findButton(vetoed, '收回否決').props!.onClick!()
    expect(onToggle).toHaveBeenCalledWith('b', 'veto')
    expect(findNode(tree, el => el.type === 'details')).toBeUndefined() // 否決的店不再收進「被排除」
    // 否決列和候選列是同一個 <li>：animation-name 與 delay 不變，切換時才不會整列重新浮現
    expect(String(vetoed!.props!.className)).toContain('animate-row-in')
    expect(vetoed!.props!.style).toEqual({ animationDelay: '0ms' })

    // 進投票時候選還沒載到（查詢失敗、重試中）：不能把空清單凍結起來
    mocks.refs = []
    mocks.refIndex = 0
    CandidateList({ rows: [], voting })
    mocks.refIndex = 0
    CandidateList({ rows: [row('a', 0.3), row('b', 0.5), row('c', 0.2)], voting })
    mocks.refIndex = 0
    expect(rowNames(CandidateList({ rows: [row('a', 0.9), row('b', 0.05), row('c', 0.05)], voting })))
      .toEqual(['店b', '店a', '店c'])

    // 投票中有人退房、重算後放回的店：第一次出現時依機率接到最後，之後機率再變也不彼此換位
    mocks.refIndex = 0
    // rows 裡 e 排在 d 前面：接到最後的順序要看機率（d 0.4 > e 0.1），不是看 rows
    CandidateList({ rows: [row('a', 0.3), row('b', 0.5), row('c', 0.2), row('e', 0.1), row('d', 0.4)], voting })
    mocks.refIndex = 0
    expect(rowNames(CandidateList({ rows: [row('a', 0.2), row('b', 0.2), row('c', 0.2), row('d', 0.05), row('e', 0.35)], voting })))
      .toEqual(['店b', '店a', '店c', '店d', '店e'])
  })
})

describe('RoomPage pending selection controls', () => {
  const candidate: CandidateRow = {
    room_id: 'room-1', restaurant_id: 'r1', status: 'kept', probability: 1,
    weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
    restaurants: { name: '店家', lat: 25, lng: 121, place_id: 'p1', source: 'google' },
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0; mocks.stateValues = [true]; mocks.stateSetters = []; mocks.effects = []
    mocks.confirmDraw.mockResolvedValue(null); mocks.redrawRoom.mockResolvedValue(null)
  })

  function pendingState(myUserId: string) {
    return {
      room: { id: 'room-1', code: 'ABC123', host_id: 'host', status: 'pending',
        exploration: 'balanced', meal_time: null, cuisine_filter: false, draw_version: 4 },
      members: [], candidates: [candidate, { ...candidate, restaurant_id: 'r2', probability: 0 }],
      draw: { room_id: 'room-1', winner_restaurant_id: 'r1', seed: 'seed', probabilities: { r1: 1 }, version: 4 },
      myUserId, connected: true, notFound: false, loadError: false, refetch: vi.fn(async (): Promise<void> => undefined),
      toggleVote: vi.fn(), hasMyVote: vi.fn(), ups: new Map(), vetoesRemaining: 2,
    }
  }

  it('只有房主能用版本 4 確認或排除重轉', async () => {
    mocks.useRoom.mockReturnValue(pendingState('host'))
    const tree = await renderRoomPage()
    const confirm = findButton(tree, '確認就吃這家')
    const redraw = findButton(tree, '排除這家並重轉')
    if (!confirm.props?.onClick || !redraw.props?.onClick) throw new Error('找不到待確認操作')
    await confirm.props.onClick()
    expect(mocks.confirmDraw).toHaveBeenCalledWith('room-1', 4)

    mocks.stateIndex = 0; mocks.stateValues = [true]; mocks.effects = []; mocks.useRoom.mockReturnValue(pendingState('member'))
    const memberTree = await renderRoomPage()
    expect(findButton(memberTree, '確認就吃這家').type).toBeUndefined()
    expect(findButton(memberTree, '排除這家並重轉').type).toBeUndefined()
  })

  it.each([
    ['確認就吃這家', mocks.confirmDraw, 'confirm'],
    ['排除這家並重轉', mocks.redrawRoom, 'redraw'],
  ] as const)('%s 成功後等 refetch 完成才解除 busy', async (label, action, kind) => {
    const reload = deferred<void>()
    const state = pendingState('host')
    state.refetch.mockReturnValue(reload.promise)
    mocks.useRoom.mockReturnValue(state)
    const tree = await renderRoomPage()
    const click = findButton(tree, label).props?.onClick
    if (!click) throw new Error(`找不到${label}`)

    const request = click()
    await Promise.resolve()
    await Promise.resolve()
    expect(action).toHaveBeenCalledWith('room-1', 4)
    expect(state.refetch).toHaveBeenCalledOnce()
    expect(mocks.stateSetters[14]).toHaveBeenCalledWith(kind)
    expect(mocks.stateSetters[14]).not.toHaveBeenCalledWith(null)

    reload.resolve(undefined)
    await request
    expect(mocks.stateSetters[14]).toHaveBeenLastCalledWith(null)
  })

  it('啟動轉盤：連點只送一次，成功後等 refetch 完成才解除 busy、不留錯誤', async () => {
    const reload = deferred<void>()
    const base = pendingState('host')
    const state = { ...base, room: { ...base.room, status: 'voting' }, draw: null }
    state.refetch.mockReturnValue(reload.promise)
    mocks.drawRoom.mockResolvedValue(null)
    mocks.useRoom.mockReturnValue(state)
    const tree = await renderRoomPage()
    // findButton 會展開 CandidateList，子元件的 useState 會覆寫 stateSetters[1..]，先抓住頁面的 setter
    const setActionError = mocks.stateSetters[1]
    const setPendingAction = mocks.stateSetters[14]
    const click = findButton(tree, '啟動轉盤').props?.onClick
    if (!click) throw new Error('找不到啟動轉盤')

    const first = click()
    const second = click()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.drawRoom).toHaveBeenCalledOnce()
    expect(mocks.drawRoom).toHaveBeenCalledWith('room-1')
    expect(state.refetch).toHaveBeenCalledOnce()
    expect(setPendingAction).toHaveBeenCalledWith('draw')
    expect(setPendingAction).not.toHaveBeenCalledWith(null)

    reload.resolve(undefined)
    await Promise.all([first, second])
    expect(setPendingAction).toHaveBeenLastCalledWith(null)
    expect(setActionError.mock.calls).toEqual([['']])
  })

  it('這台看過這次轉盤就不重播：沒看過才轉，轉完記下來，再進來直接是結果卡', async () => {
    const store = new Map<string, string>()
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } })
    const { default: DrawPanel } = await import('../components/DrawPanel')
    const { default: Wheel } = await import('../components/Wheel')
    const state = pendingState('member')
    const props = { room: state.room, draw: state.draw, candidates: state.candidates, spun: false, onSpun: vi.fn(),
      me: undefined, myUserId: 'member', isHost: false, isGuest: false, pendingAction: null, lastCandidate: false,
      onRedraw: vi.fn(), onConfirm: vi.fn() } as unknown as Parameters<typeof DrawPanel>[0]

    const wheel = findNode(DrawPanel(props), el => el.type === Wheel)
    expect(wheel).toBeDefined()
    // 轉到一半的重繪（Realtime）不能把轉盤收掉：轉完才記
    expect(store.size).toBe(0)
    expect(findNode(DrawPanel(props), el => el.type === Wheel)).toBeDefined()
    ;(wheel!.props!.onDone as () => void)()
    expect(store.get('wheel-seen:room-1')).toBe('4')
    expect(props.onSpun).toHaveBeenCalledOnce()
    expect(findNode(DrawPanel(props), el => el.type === Wheel)).toBeUndefined()
    // 重轉是新版本：照樣會播
    const redrawn = { ...props, draw: { ...props.draw, version: 5 } }
    expect(findNode(DrawPanel(redrawn), el => el.type === Wheel)).toBeDefined()
  })

  it('標頭的邀請碼鈕複製 /join 連結（訪客點了可直接入房），不是只複製 12 碼', async () => {
    const writeText = vi.fn(async () => undefined)
    vi.stubGlobal('navigator', { clipboard: { writeText } })
    mocks.useRoom.mockReturnValue(pendingState('member'))
    const tree = await renderRoomPage()
    await findButton(tree, 'ABC123').props!.onClick!()
    expect(writeText).toHaveBeenCalledWith('#/join/ABC123') // node 沒有 window，origin 為空
  })

  it('只剩抽中的一家：重轉改成「排除並回到準備階段」，先開確認框，確定才送', async () => {
    mocks.useRoom.mockReturnValue({ ...pendingState('host'), candidates: [candidate] })
    const tree = await renderRoomPage()
    const setConfirmAsk = mocks.stateSetters[19]
    expect(findButton(tree, '排除這家並重轉').type).toBeUndefined()

    const ask = openConfirm(tree, '排除並回到準備階段', setConfirmAsk)
    expect(ask.title).toBe('這是最後一家候選')
    expect(mocks.redrawRoom).not.toHaveBeenCalled()
    await ask.onConfirm()
    expect(mocks.redrawRoom).toHaveBeenCalledWith('room-1', 4)
  })

  it('兩家以上候選：排除這家並重轉直接送、不開確認框', async () => {
    mocks.useRoom.mockReturnValue(pendingState('host'))
    const tree = await renderRoomPage()
    const setConfirmAsk = mocks.stateSetters[19]
    await findButton(tree, '排除這家並重轉').props!.onClick!()
    expect(setConfirmAsk).not.toHaveBeenCalled()
    expect(mocks.redrawRoom).toHaveBeenCalledWith('room-1', 4)
  })

  it('重整／重開分頁時拿這台記下的階段來比：離開時在抽中待確認、回來時 search_version 剛好 +1 才補說明，且不搶焦點不捲動', async () => {
    const state = pendingState('member')
    const scrollBy = vi.fn()
    vi.stubGlobal('scrollBy', scrollBy)
    for (const [stored, warned] of [
      ['pending@3', true], // 排光回 lobby：3 → 4
      ['pending@2', false], // 排光後又搜尋、修改條件才回 lobby：2 → 4，最後一次回 lobby 不是排光
      ['candidates@3', false],
      [null, false],
    ] as const) {
      const store = new Map<string, string>(stored ? [['room-stage:room-1', stored]] : [])
      vi.stubGlobal('localStorage', {
        getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => { store.set(k, v) } })
      const focus = vi.fn()
      // 焦點在 body、階段開頭被標頭蓋住：換成一般換階段會捲動也會移焦點，剛載入時兩者都不該發生
      const BODY = {}
      vi.stubGlobal('document', { body: BODY, activeElement: BODY,
        querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 96 }) }) })
      vi.stubGlobal('matchMedia', () => ({ matches: false }))
      // 真實的兩段掛載：先是房間還沒載到（room 為 null），之後才是 lobby
      mocks.refs = []; mocks.stateIndex = 0; mocks.effects = []
      mocks.useRoom.mockReturnValue({ ...state, room: null, draw: null })
      await renderRoomPage()
      mocks.effects.at(-1)!()
      mocks.stateIndex = 0; mocks.effects = []
      mocks.useRoom.mockReturnValue({ ...state, room: { ...state.room, status: 'lobby', search_version: 4 }, draw: null })
      const tree = await renderRoomPage()
      ;(findNode(tree, el => el.type === 'h1')!.props!.ref as { current: unknown }).current = { focus }
      const stage = findNode(tree, el => el.type === 'div' && Array.isArray(el.props?.children) &&
        (el.props.children as NodeLike[]).some(ch => ch?.type === 'h1'))!
      ;(stage.props!.ref as { current: unknown }).current = { getBoundingClientRect: () => ({ top: 40 }) }
      const setActionWarning = mocks.stateSetters[2]
      mocks.effects.at(-1)!()
      await new Promise(r => setTimeout(r, 0))
      expect(store.get('room-stage:room-1')).toBe('lobby@4')
      if (warned) expect((setActionWarning.mock.calls[0][0] as (w: string) => string)('')).toContain('候選已經全部排除')
      else if (stored) expect((setActionWarning.mock.calls[0][0] as (w: string) => string)('')).toBe('')
      else expect(setActionWarning).not.toHaveBeenCalled()
      expect(focus).not.toHaveBeenCalled()
      expect(scrollBy).not.toHaveBeenCalled()
    }
  })

  it('從抽中待確認回到準備階段時告訴全房原因；別的換階段只收掉這則、不動其他警告', async () => {
    const state = pendingState('member')
    // 跑一次 from→to 的階段 effect，回傳它交給 setActionWarning 的 updater
    // search_version：進 lobby 時 +1（trigger），其他換階段不變
    async function transition(from: string, to: string, fromVersion = 3, toVersion = to === 'lobby' ? 4 : 3) {
      mocks.refs = []; mocks.stateIndex = 0; mocks.effects = []
      mocks.useRoom.mockReturnValue({ ...state, room: { ...state.room, status: from, search_version: fromVersion } })
      await renderRoomPage()
      mocks.effects.at(-1)!() // 階段 effect 排最後：記下前一個 status
      mocks.stateIndex = 0; mocks.effects = []
      mocks.useRoom.mockReturnValue({ ...state, room: { ...state.room, status: to, search_version: toVersion }, draw: null })
      await renderRoomPage()
      const setActionWarning = mocks.stateSetters[2]
      mocks.effects.at(-1)!()
      expect(setActionWarning).toHaveBeenCalledOnce()
      return setActionWarning.mock.calls[0][0] as (w: string) => string
    }
    const exhausted = (await transition('pending', 'lobby'))('')
    expect(exhausted).toContain('候選已經全部排除')
    // 沒重新掛載、但一次跳過好幾步（手機鎖屏後喚醒）：排光後又搜尋、修改條件才回 lobby，不是排光
    expect((await transition('pending', 'lobby', 2, 4))('')).toBe('')

    const editBack = await transition('candidates', 'lobby') // 修改條件回準備階段：不講
    expect(editBack('')).toBe('')
    const searched = await transition('lobby', 'candidates') // 重新搜尋後：收掉排光提示，快取警告留著
    expect(searched(exhausted)).toBe('')
    expect(searched('外部搜尋暫時失敗，本次使用 30 天內的快取資料')).toBe('外部搜尋暫時失敗，本次使用 30 天內的快取資料')
  })

  it('換階段：新階段開頭被標頭蓋住才捲回去、同一份清單換按鈕不捲；焦點掉在 body 才移到階段標題', async () => {
    const state = pendingState('member')
    const BODY = { tagName: 'BODY' }
    const scrollBy = vi.fn()
    vi.stubGlobal('scrollBy', scrollBy)
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    type Case = { from: string; to: string; top: number; active: object; after?: object; scroll: number | null; focus: boolean }
    const cases: Case[] = [
      { from: 'voting', to: 'pending', top: 40, active: BODY, scroll: -72, focus: true },
      { from: 'voting', to: 'pending', top: 300, active: { tagName: 'BUTTON' }, scroll: null, focus: false },
      { from: 'voting', to: 'pending', top: 40, active: { tagName: 'BUTTON' }, scroll: -72, focus: false },
      // 初選表決過半自動換階段時房主開著確認框：effect 當下焦點還在框裡，框卸載後才掉回 body
      { from: 'candidates', to: 'shortlisting', top: 300, active: { tagName: 'BUTTON' }, after: BODY, scroll: null, focus: true },
      { from: 'candidates', to: 'voting', top: 40, active: BODY, scroll: null, focus: true },
    ]
    for (const c of cases) {
      scrollBy.mockClear()
      const doc = { body: BODY, activeElement: c.active,
        querySelector: () => ({ getBoundingClientRect: () => ({ bottom: 96 }) }) }
      vi.stubGlobal('document', doc)
      mocks.refs = []; mocks.stateIndex = 0; mocks.effects = []
      mocks.useRoom.mockReturnValue({ ...state, room: { ...state.room, status: c.from } })
      await renderRoomPage()
      mocks.effects.at(-1)!() // 記下前一個 status
      mocks.stateIndex = 0; mocks.effects = []
      mocks.useRoom.mockReturnValue({ ...state, room: { ...state.room, status: c.to } })
      const tree = await renderRoomPage()
      // 這次 render 的 ref 和上一次是同一個物件（mocks.refs），effect 跑之前塞進假 DOM
      const h1 = findNode(tree, el => el.type === 'h1')!
      const stage = findNode(tree, el => el.type === 'div' && Array.isArray(el.props?.children) &&
        (el.props.children as NodeLike[]).some(ch => ch?.type === 'h1'))!
      const focus = vi.fn()
      ;(h1.props!.ref as { current: unknown }).current = { focus }
      ;(stage.props!.ref as { current: unknown }).current = { getBoundingClientRect: () => ({ top: c.top }) }
      mocks.effects.at(-1)!()
      if (c.after) doc.activeElement = c.after
      await new Promise(r => setTimeout(r, 0)) // 焦點檢查在 rAF（測試裡是 setTimeout 0）
      if (c.scroll === null) expect(scrollBy, `${c.from}→${c.to}`).not.toHaveBeenCalled()
      else expect(scrollBy).toHaveBeenCalledWith({ top: c.scroll, behavior: 'smooth' })
      if (c.focus) expect(focus).toHaveBeenCalledWith({ preventScroll: true })
      else expect(focus).not.toHaveBeenCalled()
    }
  })

  it('抽選進行中：啟動轉盤 disabled 並顯示「抽選中…」', async () => {
    const base = pendingState('host')
    mocks.useRoom.mockReturnValue({ ...base, room: { ...base.room, status: 'voting' }, draw: null })
    mocks.stateValues[14] = 'draw'
    const tree = await renderRoomPage()
    expect(findButton(tree, '抽選中…').props?.disabled).toBe(true)
    expect(findButton(tree, '啟動轉盤').type).toBeUndefined()
  })

  it('確認回傳候選耗盡時，Realtime 斷線仍重新載入並回到準備畫面', async () => {
    const api = await vi.importActual<typeof import('../lib/api')>('../lib/api')
    mocks.getSession.mockResolvedValue({ data: { session: { access_token: 'token' } } })
    mocks.confirmDraw.mockImplementation(api.confirmDraw)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify({
      status: 'lobby', exhausted: true,
    }), { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const state = pendingState('host')
    state.connected = false
    state.refetch.mockImplementation(async () => {
      mocks.useRoom.mockReturnValue({
        ...state, room: { ...state.room, status: 'lobby' }, candidates: [],
      })
    })
    mocks.useRoom.mockReturnValue(state)
    const tree = await renderRoomPage()

    await findButton(tree, '確認就吃這家').props!.onClick!()

    expect(state.refetch).toHaveBeenCalledOnce()
    expect(mocks.stateSetters[1]).toHaveBeenCalledTimes(1)
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('')
    mocks.stateIndex = 0
    const reloaded = await renderRoomPage()
    expect(findButton(reloaded, '確認就吃這家').type).toBeUndefined()
    expect(findButton(reloaded, '開始搜尋餐廳').type).toBe('button')
  })

  it.each([
    ['確認就吃這家', mocks.confirmDraw],
    ['排除這家並重轉', mocks.redrawRoom],
  ] as const)('%s 失敗時顯示錯誤且不 refetch', async (label, action) => {
    const state = pendingState('host')
    action.mockResolvedValue('房間狀態已更新')
    mocks.useRoom.mockReturnValue(state)
    const tree = await renderRoomPage()

    await findButton(tree, label).props!.onClick!()

    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('房間狀態已更新')
    expect(state.refetch).not.toHaveBeenCalled()
    expect(mocks.stateSetters[14]).toHaveBeenLastCalledWith(null)
  })

  it.each([
    ['確認就吃這家', '確認成功，但重新載入失敗，請重新整理頁面'],
    ['排除這家並重轉', '重轉成功，但重新載入失敗，請重新整理頁面'],
  ] as const)('%s 成功但 refetch 拋錯時如實回報並解除 busy', async (label, message) => {
    const state = pendingState('host')
    state.refetch.mockRejectedValue(new Error('offline'))
    mocks.useRoom.mockReturnValue(state)
    const tree = await renderRoomPage()

    await findButton(tree, label).props!.onClick!()

    expect(mocks.stateSetters[1]).toHaveBeenCalledWith(message)
    expect(mocks.stateSetters[14]).toHaveBeenLastCalledWith(null)
  })

  it('房間版本已前進時不顯示舊抽選或操作', async () => {
    const state = pendingState('host')
    state.room.draw_version = 5
    mocks.useRoom.mockReturnValue(state)
    const tree = await renderRoomPage()
    expect(textContent(tree)).toContain('正在同步最新抽選結果')
    expect(findButton(tree, '確認就吃這家').type).toBeUndefined()
    expect(findButton(tree, '排除這家並重轉').type).toBeUndefined()
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

  it('找不到房間時可回首頁，也可重試（token 刷新失敗造成的假 not-found 能自行復原）', async () => {
    const refetch = vi.fn()
    mocks.useRoom.mockReset().mockReturnValue({
      room: null, members: [], candidates: [], draw: null, myUserId: '', connected: true,
      notFound: true, loadError: false, refetch,
      toggleVote: vi.fn(), myVote: null, ups: new Map(), vetoesRemaining: 2,
    })
    const tree = await renderRoomPage()
    expect(textContent(tree)).toContain('找不到房間')
    expect(findNode(tree, el => el.type === 'a' && el.props?.to === '/')).toBeDefined()
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
      refetch: vi.fn(async (): Promise<void> => undefined),
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
    mocks.effects = []
    mocks.eq.mockReset().mockResolvedValue({ error: null, count: 1 })
    mocks.update.mockReset().mockReturnValue({ eq: mocks.eq })
    mocks.from.mockReset().mockReturnValue({ update: mocks.update })
    mocks.useRoom.mockReset().mockReturnValue(roomState())
    mocks.searchRoom.mockReset().mockResolvedValue({ error: null, warning: null })
    mocks.editConditions.mockReset().mockResolvedValue(null)
  })

  afterEach(() => {
    vi.useRealTimers()
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

  it('所有非房主都 ready 時搜尋鈕可用，房主自己的 ready 不列入', async () => {
    mocks.useRoom.mockReturnValue(roomState({ members: [hostMe, { ...memberB, ready: true }] }))
    const tree = await renderRoomPage()
    expect(findButton(tree, '開始搜尋餐廳').props?.disabled).toBe(false)
  })

  it('房內四組 segmented control 都有至少 44px 的 class', async () => {
    const tree = await renderRoomPage()
    for (const label of ['熟悉', '平均', '探索', '馬上出發', '自訂時間', '關閉', '開啟']) {
      expect(findButton(tree, label).props?.className).toContain('min-h-11')
    }
  })

  it('任一非房主未 ready 時搜尋鈕 disabled 並講還差幾人，直接呼叫 stale handler 也不送 /search', async () => {
    const tree = await renderRoomPage()
    expect(findButton(tree, '開始搜尋餐廳').type).toBeUndefined()
    const search = findButton(tree, '還有 1 人還沒準備好')
    expect(search.props?.disabled).toBe(true)
    await search.props?.onClick?.()
    expect(mocks.searchRoom).not.toHaveBeenCalled()
  })

  it('solo host 不需要 ready 即可搜尋', async () => {
    mocks.useRoom.mockReturnValue(roomState({ members: [hostMe] }))
    const tree = await renderRoomPage()
    expect(findButton(tree, '開始搜尋餐廳').props?.disabled).toBe(false)
  })

  it('host 搜尋同時等待 ConditionsForm flush 與 room-setting write chain', async () => {
    const roomWrite = deferred<{ error: null; count: number }>()
    const childFlush = deferred<boolean>()
    mocks.eq.mockReturnValueOnce(roomWrite.promise)
    mocks.useRoom.mockReturnValue(roomState({ members: [hostMe, { ...memberB, ready: true }] }))
    const tree = await renderRoomPage()

    const conditions = findNode(tree, el => typeof el.props?.onFlushAvailable === 'function')
    const register = conditions?.props?.onFlushAvailable as
      ((flush: () => Promise<boolean>) => void) | undefined
    register?.(() => childFlush.promise)

    const roomWriteDone = findButton(tree, '熟悉').props!.onClick!()
    const searchDone = findButton(tree, '開始搜尋餐廳').props!.onClick!()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.searchRoom).not.toHaveBeenCalled()

    roomWrite.resolve({ error: null, count: 1 })
    await roomWriteDone
    await Promise.resolve()
    expect(mocks.searchRoom).not.toHaveBeenCalled()

    childFlush.resolve(true)
    await searchDone
    expect(mocks.searchRoom).toHaveBeenCalledTimes(1)
    expect(mocks.searchRoom).toHaveBeenCalledWith('room-1', expect.objectContaining({
      signal: expect.any(AbortSignal),
      onRequestStart: expect.any(Function),
    }))
  })

  it('改地點階段不等待已卸載條件表單，lobby 仍維持儲存閘門', async () => {
    const room = { ...lobbyRoom, search_version: 2 }
    mocks.useRoom.mockReturnValue(roomState({ room }))
    const tree = await renderRoomPage()
    const conditions = findNode(tree, el => typeof el.props?.onFlushAvailable === 'function')
    const register = conditions!.props!.onFlushAvailable as (flush: null) => void
    register(null)
    const panel = findNode(tree, el => typeof el.props?.onChoose === 'function')
    const choose = panel!.props!.onChoose as (point: { lat: number; lng: number; label: string }) => Promise<void>
    const point = { lat: 25.05, lng: 121.52, label: '新地點' }
    await choose(point)
    expect(mocks.chooseLocation).not.toHaveBeenCalled()
    room.status = 'relocating'
    await choose(point)
    expect(mocks.chooseLocation).toHaveBeenCalledWith('room-1', point.lat, point.lng, 2)
  })

  it('preflight pending 時 unmount，晚到結果不送 search、不啟動 timer、不 setState', async () => {
    const childFlush = deferred<boolean>()
    const timerSpy = vi.spyOn(globalThis, 'setTimeout')
    mocks.useRoom.mockReturnValue(roomState({ members: [hostMe, { ...memberB, ready: true }] }))
    const tree = await renderRoomPage()
    const cleanup = mocks.effects[2]?.()
    if (typeof cleanup !== 'function') throw new Error('找不到 RoomPage lifecycle cleanup')

    const conditions = findNode(tree, el => typeof el.props?.onFlushAvailable === 'function')
    const register = conditions?.props?.onFlushAvailable as
      ((flush: () => Promise<boolean>) => void) | undefined
    register?.(() => childFlush.promise)
    const searchDone = findButton(tree, '開始搜尋餐廳').props!.onClick!()
    await Promise.resolve()
    await Promise.resolve()
    const callsBeforeUnmount = mocks.stateSetters.map(setter => setter.mock.calls.length)

    cleanup()
    childFlush.resolve(true)
    await searchDone

    expect(mocks.searchRoom).not.toHaveBeenCalled()
    expect(timerSpy).not.toHaveBeenCalledWith(expect.any(Function), 3000)
    expect(mocks.stateSetters.map(setter => setter.mock.calls.length))
      .toEqual(callsBeforeUnmount)
  })

  it('request-start callback 精確在 3000ms 啟用慢搜尋狀態', async () => {
    vi.useFakeTimers()
    const result = deferred<{ error: null; warning: null }>()
    const requestStarted = deferred<void>()
    mocks.useRoom.mockReturnValue(roomState({ members: [hostMe, { ...memberB, ready: true }] }))
    mocks.searchRoom.mockImplementation((_roomId: string, options: { onRequestStart(): void }) => {
      options.onRequestStart()
      requestStarted.resolve()
      return result.promise
    })
    const tree = await renderRoomPage()
    mocks.effects[2]?.()

    const searchDone = findButton(tree, '開始搜尋餐廳').props!.onClick!()
    await requestStarted.promise
    expect(mocks.searchRoom).toHaveBeenCalledTimes(1)
    expect(mocks.stateSetters[13]).not.toHaveBeenCalledWith(true)

    await vi.advanceTimersByTimeAsync(2999)
    expect(mocks.stateSetters[13]).not.toHaveBeenCalledWith(true)
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.stateSetters[13]).toHaveBeenCalledWith(true)

    result.resolve({ error: null, warning: null })
    await searchDone
    expect(mocks.stateSetters[13]).toHaveBeenLastCalledWith(false)
  })

  it('欄位 A 寫入失敗後，欄位 B 成功仍阻擋搜尋，直到 A 重試成功', async () => {
    mocks.eq
      .mockResolvedValueOnce({ error: { message: 'exploration failed' }, count: 0 })
      .mockResolvedValueOnce({ error: null, count: 1 })
      .mockResolvedValueOnce({ error: null, count: 1 })
    mocks.useRoom.mockReturnValue(roomState({ members: [hostMe, { ...memberB, ready: true }] }))
    const tree = await renderRoomPage()

    await findButton(tree, '熟悉').props!.onClick!()
    await findButton(tree, '開啟').props!.onClick!()
    await findButton(tree, '開始搜尋餐廳').props!.onClick!()
    expect(mocks.searchRoom).not.toHaveBeenCalled()

    await findButton(tree, '熟悉').props!.onClick!()
    await findButton(tree, '開始搜尋餐廳').props!.onClick!()
    expect(mocks.searchRoom).toHaveBeenCalledTimes(1)
  })

  it('錯誤和警告同時出現（降級的 422）：兩則橫幅都捲到最上面那則錯誤，不捲警告自己', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false }))
    mocks.stateValues[1] = '找不到符合條件的餐廳，請放寬條件'
    mocks.stateValues[2] = '外部搜尋暫時失敗，本次使用 30 天內的快取資料'
    const tree = await renderRoomPage()
    const banners = [findNode(tree, el => el.props?.role === 'alert' && el.props?.['data-action-banner'] === true)!,
      findNode(tree, el => el.type === 'p' && el.props?.role === 'status' && el.props?.['data-action-banner'] === true)!]
    const topmost = { scrollIntoView: vi.fn() }
    for (const banner of banners) {
      const self = { scrollIntoView: vi.fn(), parentElement: { querySelector: () => topmost } }
      ;(banner.props!.ref as (el: unknown) => void)(self)
      expect(self.scrollIntoView).not.toHaveBeenCalled()
    }
    expect(topmost.scrollIntoView).toHaveBeenCalledTimes(2)
    expect(topmost.scrollIntoView).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
  })

  it('搜尋 POST 超過三秒時顯示 truthful status copy', async () => {
    mocks.stateValues[13] = true
    const tree = await renderRoomPage()
    const status = findNode(tree, el => el.type === 'p' && el.props?.role === 'status')
    expect(textContent(status)).toBe('搜尋仍在進行；首次使用可能需要約 15 秒。')
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

  const keptRow = {
    room_id: 'room-1', restaurant_id: 'r1', status: 'kept', probability: 1,
    weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
    restaurants: { name: '店', lat: 25, lng: 121, place_id: 'p', source: 'google' },
  }
  const memberC = { ...hostMe, user_id: 'user-c', profiles: { display_name: '小C' } }

  it.each([
    ['lobby', false, '設好條件後，按最下方「我準備好了」'],
    ['lobby', true, '已準備好，等房主開始搜尋'],
    ['candidates', false, '候選出爐了，等房主開始投票'],
    ['voting', false, '投完票後，等房主啟動轉盤'],
    ['pending', false, '等房主確認，或排除這家重轉'],
  ])('成員視角在 %s（ready=%s）講清楚在等誰', async (status, ready, hint) => {
    mocks.useRoom.mockReturnValue(roomState({ myUserId: 'user-b', room: { ...lobbyRoom, status },
      members: [hostMe, { ...memberB, ready }], candidates: [keptRow] }))
    expect(textContent(await renderRoomPage())).toContain(hint)
  })

  it('候選多到開放初選表決時，提示成員可以先表決', async () => {
    const many = Array.from({ length: 7 }, (_, i) => ({ ...keptRow, restaurant_id: `r${i}` }))
    mocks.useRoom.mockReturnValue(roomState({ myUserId: 'user-b', room: { ...lobbyRoom, status: 'candidates' },
      candidates: many }))
    const text = textContent(await renderRoomPage())
    expect(text).toContain('候選很多：可以先表決要不要初選')
    expect(text).not.toContain('候選出爐了，等房主開始投票')
  })

  it('自己準備好但還有人沒準備：講在等其他人，不說在等房主', async () => {
    mocks.useRoom.mockReturnValue(roomState({ myUserId: 'user-b',
      members: [hostMe, { ...memberB, ready: true }, memberC] }))
    const text = textContent(await renderRoomPage())
    expect(text).toContain('已準備好，還在等 1 人')
    expect(text).not.toContain('等房主開始搜尋')
  })

  it('候選全滅時只留死路橫幅，不叫成員等轉盤', async () => {
    mocks.useRoom.mockReturnValue(roomState({ myUserId: 'user-b', room: { ...lobbyRoom, status: 'voting' },
      candidates: [{ ...keptRow, status: 'excluded', exclusion_kinds: ['veto'] }] }))
    const text = textContent(await renderRoomPage())
    expect(text).toContain('候選已全數被否決')
    expect(text).not.toContain('等房主啟動轉盤')
  })

  it('房主視角、或還不知道自己是誰時不顯示等待提示', async () => {
    mocks.useRoom.mockReturnValue(roomState({ room: { ...lobbyRoom, status: 'candidates' } }))
    expect(textContent(await renderRoomPage())).not.toContain('等房主')
  })

  it('uid 還沒讀到時不把房主當成員提示', async () => {
    mocks.useRoom.mockReturnValue(roomState({ myUserId: '' }))
    expect(textContent(await renderRoomPage())).not.toContain('我準備好了」')
  })

  it('lobby 成員視角：房主的設定收成一行摘要，沒有開關', async () => {
    mocks.useRoom.mockReturnValue({ room: { ...lobbyRoom, cuisine_filter: false },
      members: [hostMe, memberB], myUserId: 'user-b',
      candidates: [], draw: null, connected: true, notFound: false, loadError: false,
      refetch: vi.fn(), toggleVote: vi.fn(), myVote: () => null, ups: {}, vetoesRemaining: 2 })
    const tree = await renderRoomPage()
    expect(findButton(tree, '關閉').type).toBeUndefined()
    expect(findButton(tree, '平均').type).toBeUndefined()
    expect(textContent(tree)).toContain('探索檔位：平均・用餐時間：')
    expect(textContent(tree)).toContain('・菜系過濾：關閉')
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

  it('candidates 只有房主看得到「修改條件」與「開始投票」', async () => {
    mocks.useRoom.mockReturnValue(roomState({ room: { ...lobbyRoom, status: 'candidates' } }))
    const hostTree = await renderRoomPage()
    expect(findButton(hostTree, '修改條件').type).toBe('button')
    expect(findButton(hostTree, '開始投票').type).toBe('button')

    mocks.stateIndex = 0
    mocks.useRoom.mockReturnValue(roomState({
      room: { ...lobbyRoom, status: 'candidates' },
      myUserId: 'user-b',
    }))
    const guestTree = await renderRoomPage()
    expect(findButton(guestTree, '修改條件').type).toBeUndefined()
    expect(findButton(guestTree, '開始投票').type).toBeUndefined()
  })

  it('修改條件先開站內確認框；按取消不送 request、焦點回到觸發鈕', async () => {
    mocks.refs = [] // 觸發鈕記在 ref 裡，關框那次 render 要拿得到
    mocks.useRoom.mockReturnValue(roomState({ room: { ...lobbyRoom, status: 'candidates' } }))
    const tree = await renderRoomPage()
    const trigger = { focus: vi.fn() }
    const ask = openConfirm(tree, '修改條件', mocks.stateSetters[19], trigger)
    expect(ask).toMatchObject({ title: '修改條件？', confirmLabel: '清除候選並修改' })
    expect(mocks.editConditions).not.toHaveBeenCalled()

    // 框開著：背景 inert，按取消只關框
    mocks.stateIndex = 0; mocks.stateValues = []; mocks.stateValues[19] = ask
    const open = await renderRoomPage()
    const setConfirmAsk = mocks.stateSetters[19]
    expect(findNode(open, el => el.props?.inert === true)).toBeDefined()
    expect(textContent(findNode(open, el => el.props?.role === 'dialog'))).toContain(ask.body)
    findButton(open, '取消').props!.onClick!()
    expect(setConfirmAsk).toHaveBeenCalledWith(null)
    expect(mocks.editConditions).not.toHaveBeenCalled()
    expect(trigger.focus).not.toHaveBeenCalled() // 同步聚焦會被還沒解除的 inert 吃掉
    await new Promise(r => setTimeout(r, 0)) // rAF（測試裡是 setTimeout 0）之後才還原焦點
    expect(trigger.focus).toHaveBeenCalledOnce()

    // 按確定：關框並送出
    setConfirmAsk.mockClear()
    findButton(open, '清除候選並修改').props!.onClick!()
    expect(setConfirmAsk).toHaveBeenCalledWith(null)
    expect(mocks.editConditions).toHaveBeenCalledWith('room-1')
  })

  it('修改條件 busy ref 擋連點，成功只 refetch 一次', async () => {
    const pending = deferred<string | null>()
    const refetch = vi.fn()
    mocks.editConditions.mockReturnValue(pending.promise)
    mocks.useRoom.mockReturnValue(roomState({
      room: { ...lobbyRoom, status: 'candidates' },
      refetch,
    }))
    const tree = await renderRoomPage()
    const click = openConfirm(tree, '修改條件', mocks.stateSetters[19]).onConfirm

    const first = click()
    await click()
    expect(mocks.editConditions).toHaveBeenCalledTimes(1)
    expect(mocks.editConditions).toHaveBeenCalledWith('room-1')
    pending.resolve(null)
    await first

    expect(refetch).toHaveBeenCalledTimes(1)
  })

  it('修改條件錯誤顯示在既有 action alert 且不 refetch', async () => {
    const refetch = vi.fn()
    mocks.editConditions.mockResolvedValue('房間狀態已變更')
    mocks.useRoom.mockReturnValue(roomState({
      room: { ...lobbyRoom, status: 'candidates' },
      refetch,
    }))
    const tree = await renderRoomPage()

    await openConfirm(tree, '修改條件', mocks.stateSetters[19]).onConfirm()

    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('房間狀態已變更')
    expect(refetch).not.toHaveBeenCalled()
  })
})

// 初選（ADR-0010）：這裡只驗 RoomPage／CandidateList 的接線，門檻與計數規則由 lib/shortlist.test.ts 窮舉
describe('初選（Shortlist）', () => {
  const kept = (rid: string): CandidateRow => ({
    room_id: 'room-1', restaurant_id: rid, status: 'kept', probability: 0.1,
    weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
    restaurants: { name: rid, lat: 25, lng: 121, place_id: rid, source: 'mock' },
  })
  const member = (uid: string, name: string) => ({
    room_id: 'room-1', user_id: uid, budget_max: 800, cuisines: [], dietary: [],
    max_distance_m: 1000, transport: 'walking', ready: true, profiles: { display_name: name },
  })
  const picks = (uid: string, rids: string[]) =>
    rids.map(restaurant_id => ({ room_id: 'room-1', user_id: uid, restaurant_id }))
  const rids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] // 2 人 × 3 = 6，7 家才過門檻

  function state(status: string, overrides: Record<string, unknown> = {}) {
    return {
      room: { id: 'room-1', code: 'C', host_id: 'host-1', status,
        exploration: 'balanced', meal_time: null, cuisine_filter: false, search_version: 3 },
      members: [member('host-1', '房主'), member('user-b', '小B')],
      candidates: rids.map(kept), draw: null, myUserId: 'host-1',
      connected: true, notFound: false, loadError: false, refetch: vi.fn(async (): Promise<void> => undefined),
      toggleVote: vi.fn(), togglePick: vi.fn(async (): Promise<string | null> => null),
      hasMyVote: vi.fn(), ups: {}, vetoesRemaining: 2, shortlistVotes: [], shortlistPicks: [],
      ...overrides,
    }
  }

  async function render(status: string, overrides: Record<string, unknown> = {}) {
    mocks.stateIndex = 0
    mocks.useRoom.mockReturnValue(state(status, overrides))
    return renderRoomPage()
  }

  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0; mocks.stateValues = []; mocks.stateSetters = []; mocks.effects = []
  })

  const panel = (tree: unknown) => findNode(tree, el => el.type === ShortlistVotePanel)

  it('候選出爐：kept 多於成員數 × 3 才對全員顯示初選表決，排除的店不算', async () => {
    const open = await render('candidates', {
      myUserId: 'user-b', shortlistVotes: [{ room_id: 'room-1', user_id: 'user-b' }],
    })
    expect(panel(open)?.props).toMatchObject({ wantShortlist: true, yesCount: 1, memberCount: 2 })

    const closed = await render('candidates', {
      candidates: [...rids.slice(0, 6).map(kept), { ...kept('r7'), status: 'excluded' }],
    })
    expect(panel(closed)).toBeUndefined()
  })

  it('表決送出後 refetch；錯誤原文顯示', async () => {
    const tree = await render('candidates')
    const onVote = panel(tree)!.props!.onVote as (want: boolean) => Promise<void>
    await onVote(true)
    expect(mocks.voteShortlist).toHaveBeenCalledWith('room-1', true, 3)
    expect(mocks.useRoom.mock.results[0].value.refetch).toHaveBeenCalledOnce()

    mocks.voteShortlist.mockResolvedValueOnce('候選沒有超過成員數的 3 倍，不需要初選')
    await onVote(true)
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('候選沒有超過成員數的 3 倍，不需要初選')
  })

  it('表決已送出成功、只是重新載入失敗：如實說成功了，不說無法連線', async () => {
    const tree = await render('candidates', { refetch: vi.fn(async (): Promise<void> => { throw new Error('offline') }) })
    const onVote = panel(tree)!.props!.onVote as (want: boolean) => Promise<void>
    await onVote(true)
    expect(mocks.voteShortlist).toHaveBeenCalledWith('room-1', true, 3)
    expect(mocks.stateSetters[1].mock.calls).toEqual([[''], ['初選表決成功，但重新載入失敗，請重新整理頁面']])
  })

  // busy state 要等重繪才生效：同一瞬間的兩下要靠 ref 鎖擋
  it.each([
    ['初選表決', 'candidates', ShortlistVotePanel, mocks.voteShortlist],
    ['改地點表決', 'voting', RelocationPanel, mocks.voteLocation],
  ] as const)('%s 同一瞬間連點只送一次', async (_label, status, Panel, send) => {
    const tree = await render(status)
    const onVote = findNode(tree, el => el.type === Panel)!.props!.onVote as (want: boolean) => Promise<void>
    await Promise.all([onVote(true), onVote(true)])
    expect(send).toHaveBeenCalledOnce()
  })

  it('初選中：每位成員（含房主）顯示 kept 圈選數，取代準備狀態', async () => {
    const tree = await render('shortlisting', {
      // user-b 的 gone 不是候選，不算數
      shortlistPicks: [...picks('host-1', ['r1', 'r2', 'r3']), ...picks('user-b', ['r1', 'gone'])],
    })
    const text = textContent(tree)
    expect(text).toContain('已圈 3 家')
    expect(text).toContain('圈選中 1/3')
    expect(text).not.toContain('已準備')
    expect(text).toContain('全員圈滿 3 家後房主可以開始投票；沒人圈的店不進轉盤')
  })

  it('初選中房主：有人沒圈滿時開始投票 disabled 並說明人數，圈滿後可開始', async () => {
    const waiting = await render('shortlisting', {
      shortlistPicks: [...picks('host-1', ['r1', 'r2', 'r3']), ...picks('user-b', ['r1'])],
    })
    expect(findButton(waiting, '還有 1 人沒圈滿 3 家').props?.disabled).toBe(true)
    expect(findButton(waiting, '開始投票').type).toBeUndefined()

    const reload = deferred<void>()
    const refetch = vi.fn((): Promise<void> => reload.promise)
    const ready = await render('shortlisting', {
      refetch,
      shortlistPicks: [...picks('host-1', ['r1', 'r2', 'r3']), ...picks('user-b', ['r1', 'r4', 'r5'])],
    })
    // findButton 會展開子元件並覆寫 stateSetters，先抓住 setStartingVoting
    const setStartingVoting = mocks.stateSetters[8]
    const start = findButton(ready, '開始投票')
    expect(start.props?.disabled).toBe(false)
    const request = start.props!.onClick!()
    await Promise.resolve()
    await Promise.resolve()
    expect(mocks.startVoting).toHaveBeenCalledWith('room-1')
    expect(refetch).toHaveBeenCalledOnce()
    // 成功後先 refetch 才解鎖：Realtime 到之前按鈕不能再按
    expect(setStartingVoting).not.toHaveBeenCalledWith(false)
    reload.resolve(undefined)
    await request
    expect(setStartingVoting).toHaveBeenLastCalledWith(false)
    expect(findButton(ready, '修改條件').type).toBe('button')
  })

  it('初選中成員：可圈選但看不到房主控制項；圈選錯誤原文顯示', async () => {
    const togglePick = vi.fn(async () => '每人最多圈選 5 家')
    const tree = await render('shortlisting', {
      myUserId: 'user-b', togglePick,
      shortlistPicks: [...picks('user-b', ['r1', 'r2']), ...picks('host-1', ['r1'])],
    })
    expect(findButton(tree, '取消初選').type).toBeUndefined()
    expect(findButton(tree, '修改條件').type).toBeUndefined()
    const list = findNode(tree, el => el.type === CandidateList)
    const picking = list?.props?.picking as { myCount: number; counts: Record<string, number>;
      isPicked(rid: string): boolean; onToggle(rid: string): Promise<void> }
    expect(picking.myCount).toBe(2)
    expect(picking.counts).toEqual({ r1: 2, r2: 1 })
    expect(picking.isPicked('r2')).toBe(true)
    expect(picking.isPicked('r3')).toBe(false)
    await picking.onToggle('r3')
    expect(togglePick).toHaveBeenCalledWith('r3')
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith('每人最多圈選 5 家')
  })

  it('取消初選先開站內確認框；確定才送並 refetch', async () => {
    const tree = await render('shortlisting')
    const ask = openConfirm(tree, '取消初選', mocks.stateSetters[19])
    expect(ask).toMatchObject({ title: '取消初選？', body: '取消初選會清除所有人的圈選，回到候選出爐。' })
    expect(mocks.cancelShortlist).not.toHaveBeenCalled()

    await ask.onConfirm()
    expect(mocks.cancelShortlist).toHaveBeenCalledWith('room-1')
    expect(mocks.useRoom.mock.results[0].value.refetch).toHaveBeenCalledOnce()
  })

  it('CandidateList 圈選：aria-pressed、各店人數、額度用滿時只擋沒圈的店', () => {
    const onToggle = vi.fn()
    const tree = CandidateList({ rows: [kept('r1'), kept('r2')], picking: {
      isPicked: rid => rid === 'r1', counts: { r1: 2 }, myCount: 5, onToggle,
    } })
    expect(textContent(tree)).toContain('已圈 5/5（至少 3 家）')
    const picked = findNode(tree, el => el.type === 'button' && textContent(el) === '圈選（2 人）')
    const other = findNode(tree, el => el.type === 'button' && textContent(el) === '圈選')
    expect(picked?.props?.['aria-pressed']).toBe(true)
    expect(picked?.props?.disabled).toBe(false)
    expect(other?.props?.['aria-pressed']).toBe(false)
    expect(other?.props?.disabled).toBe(true)
    ;(picked!.props!.onClick as () => void)()
    expect(onToggle).toHaveBeenCalledWith('r1')
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
      rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 1, isHost: false, stale: false }],
    })
    expect(mocks.stateSetters[LEAVE_CHECKING]).toHaveBeenCalledWith(true)
    expect(mocks.stateSetters[LEAVE_CHECKING]).toHaveBeenCalledWith(false)
    // 查房籍期間背景還沒 inert，可能先開了「修改條件」確認框：兩個 dialog 不能疊在一起
    expect(mocks.stateSetters[19]).toHaveBeenCalledWith(null)
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

  // 上一頁回到房內時首頁的末位退房還在飛（冷啟動）：當場查會誤問、等它則按鈕無聲卡住
  it('首頁的退房還在飛：不查房籍，直接回首頁', async () => {
    mocks.members = { data: [row('room-1', 'ABC123', 'pending')], error: null }
    mocks.pendingLeave.mockReturnValueOnce(new Promise<void>(() => {}))
    const tree = await mount()
    const preventDefault = await clickHome(tree)
    expect(preventDefault).toHaveBeenCalled()
    expect(mocks.navigate).toHaveBeenCalledWith('/')
    expect(mocks.from).not.toHaveBeenCalledWith('room_members')
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

  // PR #17 回歸：背景整塊帶著 inert（fixed 遮罩對 tab 順序沒用，只好整塊 inert），
  // 而 setLeaveDialog(null) 不同步 flush——同一輪呼叫 focus() 時觸發元素還在 inert
  // 子樹內，瀏覽器直接忽略，焦點掉回 document.body。所以斷言的是「延後」這件事本身：
  // 關閉當下不得呼叫 focus()，要等 rAF 那一拍（inert 已隨 commit 移除）才還原。
  it('關閉後的焦點還原排到 rAF，不在還帶著 inert 的同一輪呼叫', async () => {
    const raf = vi.fn((_cb: () => void) => 0)
    vi.stubGlobal('requestAnimationFrame', raf)
    try {
      const tree = await mount({
        kind: 'rooms',
        rooms: [{ id: 'room-1', code: 'ABC123', status: 'voting', memberCount: 2, isHost: false }],
      })
      const focus = vi.fn()
      const triggerRef = findNode(tree, el => el.props?.['aria-label'] === '回首頁')
        ?.props?.ref as { current: unknown } | undefined
      if (!triggerRef) throw new Error('header 回首頁連結沒有掛 ref')
      triggerRef.current = { focus }

      const cancel = findButton(tree, '取消')
      if (!cancel.props?.onClick) throw new Error('找不到取消按鈕')
      await cancel.props.onClick()
      expect(mocks.stateSetters[LEAVE_DIALOG]).toHaveBeenCalledExactlyOnceWith(null)
      expect(focus).not.toHaveBeenCalled() // 這一輪背景還是 inert，現在 focus() 只會被忽略
      expect(raf).toHaveBeenCalledTimes(1)
      raf.mock.calls[0][0]()
      expect(focus).toHaveBeenCalledTimes(1) // 下一幀 inert 已移除，這次才真的聚焦得到

      // Esc 走同一條 closeLeave（實測就是 Esc 關閉後 activeElement 掉回 body）
      raf.mockClear()
      focus.mockClear()
      mocks.stateSetters[LEAVE_DIALOG].mockClear()
      const onKeyDown = findNode(tree, el => typeof el.props?.onKeyDown === 'function')!
        .props!.onKeyDown as (e: { key: string }) => void
      onKeyDown({ key: 'Escape' })
      expect(mocks.stateSetters[LEAVE_DIALOG]).toHaveBeenCalledExactlyOnceWith(null)
      expect(focus).not.toHaveBeenCalled()
      expect(raf).toHaveBeenCalledTimes(1)
      raf.mock.calls[0][0]()
      expect(focus).toHaveBeenCalledTimes(1)
    } finally {
      vi.unstubAllGlobals()
    }
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

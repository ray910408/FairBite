// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import CandidateList from '../components/CandidateList'
import type { useRoom } from '../hooks/useRoom'
import * as api from '../lib/api'
import type { DeparturePoint } from '../lib/departure'
import { leaveNotice } from '../lib/leaveNotice'
import type { CandidateRow, DrawRow, MemberRow, Room } from '../lib/types'
import { getUid } from '../lib/uid'
import { captureFrames, deferred } from '../test/dom'
import RoomPage from './RoomPage'

// 行為測試：真的 React hooks 跑在 jsdom 上，只在模組邊界 mock——useRoom（房間資料與 Realtime）、
// lib/api（Go 伺服器）、lib/supabase（PostgREST 查詢）、lib/uid，以及包 Leaflet 的 LocationPicker。
// 斷言只看畫面（role／文字／屬性）與送出去的呼叫參數，不看頁面內部有幾個 state。

type RoomState = ReturnType<typeof useRoom>
type WriteResult = { error: { message: string } | null; count: number | null }
type SelectResult = { data: unknown[] | null; error: { message: string } | null }

const mocks = vi.hoisted(() => {
  // useRoom 的替身：外部 store，測試改值就像 Realtime 推來一包新資料
  let state: RoomState | undefined
  const listeners = new Set<() => void>()
  const room = {
    get: () => state as RoomState,
    set(next: RoomState) {
      state = next
      listeners.forEach(listener => listener())
    },
    subscribe(listener: () => void) {
      listeners.add(listener)
      return () => { listeners.delete(listener) }
    },
  }

  const update = vi.fn<(table: string, patch: Record<string, unknown>, options: unknown) => void>()
  const eq = vi.fn<(table: string, column: string, value: unknown) => void>()
  const roomsWrite = vi.fn(async (): Promise<WriteResult> => ({ error: null, count: 1 }))
  const memberWrite = vi.fn(async (): Promise<WriteResult> => ({ error: null, count: 1 }))
  const memberRows = vi.fn(async (): Promise<SelectResult> => ({ data: [], error: null }))
  // supabase.from(table) 的最小替身：update(...).eq(...)[.eq(...)] 可 await，select(...) 回房籍列
  const from = vi.fn((table: string) => ({
    update(patch: Record<string, unknown>, options: unknown) {
      update(table, patch, options)
      let result: Promise<WriteResult> | undefined
      const chain = {
        eq(column: string, value: unknown) {
          eq(table, column, value)
          return chain
        },
        then(resolve: (r: WriteResult) => unknown, reject?: (e: unknown) => unknown) {
          result ??= table === 'rooms' ? roomsWrite() : memberWrite()
          return result.then(resolve, reject)
        },
      }
      return chain
    },
    select: () => memberRows(),
  }))

  return {
    room, from, update, eq, roomsWrite, memberWrite, memberRows,
    getSession: vi.fn(async () => ({ data: { session: { access_token: 'token' } } })),
    getUser: vi.fn(async () => ({ data: { user: { is_anonymous: false } } })),
    picked: { lat: 25.05, lng: 121.52, label: '新地點' } as DeparturePoint,
  }
})

vi.mock('../hooks/useRoom', async () => {
  const { useSyncExternalStore } = await import('react')
  return { useRoom: () => useSyncExternalStore(mocks.room.subscribe, mocks.room.get) }
})
vi.mock('../lib/api')
vi.mock('../lib/uid')
vi.mock('../lib/supabase', () => ({
  supabase: { from: mocks.from, auth: { getSession: mocks.getSession, getUser: mocks.getUser } },
}))
// 地圖（Leaflet）在 jsdom 跑不起來：換成一顆「選了這個點」的按鈕
vi.mock('../components/LocationPicker', async () => {
  const { createElement } = await import('react')
  return {
    default: ({ onChange }: { onChange: (p: DeparturePoint) => void }) =>
      createElement('button', { type: 'button', onClick: () => onChange(mocks.picked) }, '在地圖選這裡'),
  }
})

const HOST = 'host'
const GUEST = 'guest'
const EXHAUSTED = /候選已經全部排除/
const SLOW_SEARCH = '搜尋仍在進行；首次使用可能需要約 15 秒。'

function makeRoom(over: Partial<Room> = {}): Room {
  return {
    id: 'room-1', code: 'ABC123', host_id: HOST, status: 'lobby', exploration: 'balanced',
    meal_time: null, cuisine_filter: false, draw_version: 4, search_version: 3, ...over,
  }
}

function member(userId: string, name: string, over: Partial<MemberRow> = {}): MemberRow {
  return {
    room_id: 'room-1', user_id: userId, budget_max: 800, cuisines: [], dietary: [], max_distance_m: 1000,
    transport: 'walking', ready: false, profiles: { display_name: name }, ...over,
  }
}

function candidate(id: string, over: Partial<CandidateRow> = {}): CandidateRow {
  return {
    room_id: 'room-1', restaurant_id: id, status: 'kept', probability: 0.5, weight_breakdown: [],
    exclusion_reason: null, exclusion_kinds: [],
    restaurants: { name: `店${id}`, lat: 25, lng: 121, place_id: id, source: 'mock' }, ...over,
  }
}

const hostMember = member(HOST, '房主')
const guestMember = (over: Partial<MemberRow> = {}) => member(GUEST, '小B', over)
const DRAW: DrawRow = { room_id: 'room-1', winner_restaurant_id: 'r1', seed: 'seed', probabilities: { r1: 1 }, version: 4 }

function roomState(room: Partial<Room> | null, over: Partial<RoomState> = {}): RoomState {
  return {
    room: room && makeRoom(room), members: [hostMember, guestMember()], candidates: [], draw: null,
    locationVotes: [], shortlistVotes: [], shortlistPicks: [], myUserId: HOST, connected: true,
    notFound: false, loadError: false, refetch: vi.fn(async () => {}),
    toggleVote: vi.fn(async () => null), togglePick: vi.fn(async () => null),
    hasMyVote: () => false, ups: {}, vetoesRemaining: 2, ...over,
  }
}

// lobby 的房主；guestReady 讓另一位成員準備好（搜尋鈕才可按）
const lobby = (over: Partial<RoomState> = {}, guestReady = false) =>
  roomState({}, { members: [hostMember, guestMember({ ready: guestReady })], ...over })
const lobbyReady = (over: Partial<RoomState> = {}) => lobby(over, true)

// 抽中待確認：r1 是抽中的店；成員清單留空（同舊測試），只看抽選控制項
const pending = (me: string, over: Partial<RoomState> = {}) => roomState({ status: 'pending' }, {
  members: [], myUserId: me, draw: DRAW, ...over,
  candidates: over.candidates ?? [candidate('r1', { probability: 1 }), candidate('r2', { probability: 0 })],
})

const inStage = (status: Room['status'], me = HOST, over: Partial<RoomState> = {}) =>
  roomState({ status }, { myUserId: me, members: [hostMember, guestMember({ ready: true })],
    candidates: [candidate('r1'), candidate('r2')], ...over })

function Home() {
  const { state } = useLocation()
  return <p>首頁{state ? ` ${JSON.stringify(state)}` : ''}</p>
}

// 讓 mock 的 promise（getUser、房籍查詢、動作、寫入）在 act 裡落地
async function settle() {
  await act(async () => {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0)
    else await new Promise(resolve => setTimeout(resolve, 0))
  })
}

async function renderRoom(state: RoomState) {
  mocks.room.set(state)
  const view = render(
    <MemoryRouter initialEntries={['/room/room-1']}>
      <Routes>
        <Route path="/room/:id" element={<RoomPage />} />
        <Route path="/" element={<Home />} />
      </Routes>
    </MemoryRouter>,
  )
  await settle()
  return view
}

// Realtime 推來新資料
function push(next: RoomState) {
  act(() => mocks.room.set(next))
}

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name })
const queryButton = (name: string | RegExp) => screen.queryByRole<HTMLButtonElement>('button', { name })
const pressed = (el: HTMLElement) => el.getAttribute('aria-pressed')
const alertText = () => screen.getByRole('alert').textContent
const homeLink = () => screen.getByRole('link', { name: '回首頁' })
const dialog = () => screen.getByRole('dialog')
const inDialog = (name: string) => within(dialog()).getByRole<HTMLButtonElement>('button', { name })
const candidateRow = (name: string) => screen.getAllByTestId('candidate-row')
  .find(li => within(li).getByTestId('candidate-name').textContent === name)!

// 版面量測：jsdom 沒有 layout，換階段 effect 讀的標頭底緣與階段開頭由這裡給
function layout(stageTop: number, headerBottom = 96) {
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
    if (this.tagName === 'HEADER') return { bottom: headerBottom } as DOMRect
    if (this.querySelector(':scope > h1')) return { top: stageTop } as DOMRect
    return {} as DOMRect
  })
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getUid).mockResolvedValue(HOST)
  for (const send of [api.confirmDraw, api.redrawRoom, api.drawRoom, api.startVoting, api.editConditions,
    api.cancelShortlist, api.voteShortlist, api.voteLocation, api.chooseLocation] as const) {
    vi.mocked(send).mockResolvedValue(null)
  }
  vi.mocked(api.searchRoom).mockResolvedValue({ error: null, warning: null })
  vi.mocked(api.pendingLeave).mockReturnValue(null)
})

describe('RoomPage 用餐時間草稿', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('馬上出發後於 debounce 內重選自訂時間會取消排隊中的歸零', async () => {
    await renderRoom(lobby())
    fireEvent.click(button('馬上出發'))
    fireEvent.click(button('自訂時間'))
    await act(() => vi.advanceTimersByTimeAsync(401))
    await settle()

    expect(mocks.update).not.toHaveBeenCalled()
    expect(pressed(button('自訂時間'))).toBe('true')
    expect(screen.getByRole('combobox', { name: '用餐時間（時）' })).toBeTruthy()
  })

  it('馬上出發寫入鎖定房間 id；count 0（RLS 擋下）時顯示用餐時間錯誤', async () => {
    mocks.roomsWrite.mockResolvedValue({ error: null, count: 0 })
    await renderRoom(lobby())
    fireEvent.click(button('馬上出發'))
    await act(() => vi.advanceTimersByTimeAsync(401))
    await settle()

    expect(mocks.update).toHaveBeenCalledWith('rooms', { meal_time: null }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('rooms', 'id', 'room-1')
    expect(alertText()).toBe('用餐時間更新失敗')
  })
})

describe('CandidateList 投票與圈選', () => {
  it('同店 up/veto 各自 pressed；額度用盡仍可收回 veto', () => {
    render(<CandidateList rows={[candidate('r1', { probability: 1 })]} voting={{
      hasMyVote: () => true, ups: { r1: 1 }, vetoesRemaining: 0, onToggle: vi.fn(),
    }} />)
    expect(pressed(button('贊成（1）'))).toBe('true')
    expect(pressed(button('否決'))).toBe('true')
    expect(button('否決').disabled).toBe(false)
  })

  it('投票中順序固定：贊成改變機率不重排，被否決的店留在原位、可就地收回', () => {
    const row = (id: string, probability: number | null, extra: Partial<CandidateRow> = {}) =>
      candidate(id, { probability, ...extra })
    const onToggle = vi.fn()
    const voting = { hasMyVote: (rid: string, kind: 'up' | 'veto') => kind === 'veto' && rid === 'b',
      ups: {}, vetoesRemaining: 1, onToggle }
    const names = () => screen.getAllByTestId(/^(candidate|vetoed)-row$/).map(li => li.textContent!.match(/店\w/)![0])

    const first = render(<CandidateList rows={[row('a', 0.3), row('b', 0.5), row('c', 0.2)]} voting={voting} />)
    expect(names()).toEqual(['店b', '店a', '店c'])
    const rowB = candidateRow('店b')

    first.rerender(<CandidateList rows={[row('a', 0.9), row('c', 0.1), row('b', null, {
      status: 'excluded', exclusion_kinds: ['veto'], exclusion_reason: '遭 小明 否決（可收回）' })]} voting={voting} />)
    expect(names()).toEqual(['店b', '店a', '店c'])
    const vetoed = screen.getByTestId('vetoed-row')
    expect(vetoed.textContent).toContain('遭 小明 否決（可收回）')
    fireEvent.click(within(vetoed).getByRole('button', { name: '收回否決' }))
    expect(onToggle).toHaveBeenCalledWith('b', 'veto')
    expect(document.querySelector('details')).toBeNull() // 否決的店不再收進「被排除」
    // 否決列和候選列是同一個 <li>：animation-name 與 delay 不變，切換時才不會整列重新浮現
    expect(vetoed).toBe(rowB)
    expect(vetoed.className).toContain('animate-row-in')
    expect(vetoed.style.animationDelay).toBe('0ms')
    first.unmount()

    // 進投票時候選還沒載到（查詢失敗、重試中）：不能把空清單凍結起來
    const second = render(<CandidateList rows={[]} voting={voting} />)
    second.rerender(<CandidateList rows={[row('a', 0.3), row('b', 0.5), row('c', 0.2)]} voting={voting} />)
    second.rerender(<CandidateList rows={[row('a', 0.9), row('b', 0.05), row('c', 0.05)]} voting={voting} />)
    expect(names()).toEqual(['店b', '店a', '店c'])

    // 投票中有人退房、重算後放回的店：第一次出現時依機率接到最後，之後機率再變也不彼此換位
    // rows 裡 e 排在 d 前面：接到最後的順序要看機率（d 0.4 > e 0.1），不是看 rows
    second.rerender(<CandidateList rows={[row('a', 0.3), row('b', 0.5), row('c', 0.2), row('e', 0.1), row('d', 0.4)]}
      voting={voting} />)
    second.rerender(<CandidateList rows={[row('a', 0.2), row('b', 0.2), row('c', 0.2), row('d', 0.05), row('e', 0.35)]}
      voting={voting} />)
    expect(names()).toEqual(['店b', '店a', '店c', '店d', '店e'])
  })

  it('CandidateList 圈選：aria-pressed、各店人數、額度用滿時只擋沒圈的店', () => {
    const onToggle = vi.fn()
    render(<CandidateList rows={[candidate('r1'), candidate('r2')]} picking={{
      isPicked: rid => rid === 'r1', counts: { r1: 2 }, myCount: 5, onToggle,
    }} />)
    expect(screen.getByText('已圈 5/5（至少 3 家）')).toBeTruthy()
    const picked = button('圈選（2 人）')
    const other = button('圈選')
    expect(pressed(picked)).toBe('true')
    expect(picked.disabled).toBe(false)
    expect(pressed(other)).toBe('false')
    expect(other.disabled).toBe(true)
    fireEvent.click(picked)
    expect(onToggle).toHaveBeenCalledWith('r1')
  })
})

describe('RoomPage 抽選與待確認', () => {
  // 這台已看過版本 4 的轉盤：直接是結果卡與房主的確認／重轉
  beforeEach(() => { localStorage.setItem('wheel-seen:room-1', '4') })

  it('只有房主能用版本 4 確認或排除重轉', async () => {
    const host = await renderRoom(pending(HOST))
    fireEvent.click(button('確認就吃這家'))
    await settle()
    expect(api.confirmDraw).toHaveBeenCalledWith('room-1', 4)
    host.unmount()

    await renderRoom(pending(GUEST))
    expect(queryButton('確認就吃這家')).toBeNull()
    expect(queryButton('排除這家並重轉')).toBeNull()
  })

  it.each([
    ['確認就吃這家', 'confirmDraw', '確認中…'],
    ['排除這家並重轉', 'redrawRoom', '重轉中…'],
  ] as const)('%s 成功後等 refetch 完成才解除 busy', async (label, action, busyLabel) => {
    const reload = deferred<void>()
    const state = pending(HOST, { refetch: vi.fn(() => reload.promise) })
    await renderRoom(state)
    fireEvent.click(button(label))
    await settle()

    expect(api[action]).toHaveBeenCalledWith('room-1', 4)
    expect(state.refetch).toHaveBeenCalledOnce()
    expect(button(busyLabel).disabled).toBe(true)
    expect(queryButton(label)).toBeNull()

    await act(async () => reload.resolve())
    expect(button(label).disabled).toBe(false)
  })

  // 抽選、確認、重轉是同一把鎖：同一瞬間按到確認又按到重轉，只能送出先按的那個
  it('確認與重轉共用一把鎖：同一瞬間兩顆都按到，只送出一個', async () => {
    await renderRoom(pending(HOST))
    const confirm = button('確認就吃這家')
    const redraw = button('排除這家並重轉')
    await act(async () => { confirm.click(); redraw.click() })
    await settle()
    expect(api.confirmDraw).toHaveBeenCalledOnce()
    expect(api.redrawRoom).not.toHaveBeenCalled()
  })

  it('啟動轉盤：連點只送一次，抽選中 disabled，成功後等 refetch 完成才解除 busy、不留錯誤', async () => {
    const reload = deferred<void>()
    const state = inStage('voting', HOST, { refetch: vi.fn(() => reload.promise) })
    await renderRoom(state)
    const draw = button('啟動轉盤')
    // 同一瞬間的兩下：React 還沒重繪，第二下看到的仍是可按的按鈕
    await act(async () => { draw.click(); draw.click() })
    await settle()

    expect(api.drawRoom).toHaveBeenCalledOnce()
    expect(api.drawRoom).toHaveBeenCalledWith('room-1')
    expect(state.refetch).toHaveBeenCalledOnce()
    expect(button('抽選中…').disabled).toBe(true)
    expect(queryButton('啟動轉盤')).toBeNull()

    await act(async () => reload.resolve())
    expect(button('啟動轉盤').disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('投票中只有房主看得到啟動轉盤', async () => {
    const guest = await renderRoom(inStage('voting', GUEST))
    expect(queryButton('啟動轉盤')).toBeNull()
    guest.unmount()

    await renderRoom(inStage('voting', HOST))
    expect(button('啟動轉盤')).toBeTruthy()
  })

  it('這台看過這次轉盤就不重播：沒看過才轉，轉完記下來，再進來直接是結果卡', async () => {
    localStorage.removeItem('wheel-seen:room-1')
    vi.useFakeTimers()
    const state = pending(GUEST)
    const first = await renderRoom(state)
    expect(screen.getByText('轉盤抽選中…')).toBeTruthy()

    // 轉到一半的重繪（Realtime）不能把轉盤收掉：轉完才記
    await act(() => vi.advanceTimersByTimeAsync(2000))
    push({ ...state })
    expect(screen.getByText('轉盤抽選中…')).toBeTruthy()
    expect(localStorage.getItem('wheel-seen:room-1')).toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(2200))
    expect(localStorage.getItem('wheel-seen:room-1')).toBe('4')
    expect(screen.queryByText('轉盤抽選中…')).toBeNull()
    expect(screen.getByRole('heading', { name: '店r1' })).toBeTruthy() // 結果卡
    first.unmount()

    // 重新進房：直接是結果卡
    await renderRoom(state)
    expect(screen.queryByText('轉盤抽選中…')).toBeNull()
    expect(screen.getByRole('heading', { name: '店r1' })).toBeTruthy()

    // 重轉是新版本：照樣會播
    push({ ...state, room: makeRoom({ status: 'pending', draw_version: 5 }), draw: { ...DRAW, version: 5 } })
    expect(screen.getByText('轉盤抽選中…')).toBeTruthy()
  })

  it('標頭的邀請碼鈕複製 /join 連結（訪客點了可直接入房），不是只複製 12 碼', async () => {
    const writeText = vi.fn(async (_text: string) => undefined)
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
    try {
      await renderRoom(pending(GUEST))
      fireEvent.click(button(/邀請碼 ABC123/))
      await settle()
      expect(writeText).toHaveBeenCalledWith('http://localhost:3000/#/join/ABC123')
      expect(screen.getByText('邀請連結已複製')).toBeTruthy()
    } finally {
      delete (navigator as { clipboard?: unknown }).clipboard
    }
  })

  it('只剩抽中的一家：重轉改成「排除並回到準備階段」，先開確認框，確定才送', async () => {
    await renderRoom(pending(HOST, { candidates: [candidate('r1', { probability: 1 })] }))
    expect(queryButton('排除這家並重轉')).toBeNull()

    fireEvent.click(button('排除並回到準備階段'))
    expect(within(dialog()).getByRole('heading', { name: '這是最後一家候選' })).toBeTruthy()
    expect(dialog().textContent).toContain('排除後就沒有候選了：全房會回到準備階段')
    expect(api.redrawRoom).not.toHaveBeenCalled()

    fireEvent.click(inDialog('排除並回到準備階段'))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.redrawRoom).toHaveBeenCalledWith('room-1', 4)
  })

  it('兩家以上候選：排除這家並重轉直接送、不開確認框', async () => {
    await renderRoom(pending(HOST))
    fireEvent.click(button('排除這家並重轉'))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.redrawRoom).toHaveBeenCalledWith('room-1', 4)
  })

  it('確認回傳候選耗盡時，Realtime 斷線仍重新載入並回到準備畫面', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
    vi.mocked(api.confirmDraw).mockImplementation(actual.confirmDraw)
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ status: 'lobby', exhausted: true }),
      { status: 200, headers: { 'Content-Type': 'application/json' } })))
    const state = pending(HOST, { connected: false })
    state.refetch = vi.fn(async () => {
      mocks.room.set({ ...state, room: makeRoom({ status: 'lobby', search_version: 4 }), candidates: [], draw: null })
    })
    await renderRoom(state)

    fireEvent.click(button('確認就吃這家'))
    await settle()

    expect(state.refetch).toHaveBeenCalledOnce()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(queryButton('確認就吃這家')).toBeNull()
    expect(button('開始搜尋餐廳')).toBeTruthy()
  })

  it.each([
    ['確認就吃這家', 'confirmDraw'],
    ['排除這家並重轉', 'redrawRoom'],
  ] as const)('%s 失敗時顯示錯誤且不 refetch', async (label, action) => {
    vi.mocked(api[action]).mockResolvedValue('房間狀態已更新')
    const state = pending(HOST)
    await renderRoom(state)
    fireEvent.click(button(label))
    await settle()

    expect(alertText()).toBe('房間狀態已更新')
    expect(state.refetch).not.toHaveBeenCalled()
    expect(button(label).disabled).toBe(false)
  })

  it.each([
    ['確認就吃這家', 'confirmDraw', '確認失敗：無法連線到伺服器'],
    ['排除這家並重轉', 'redrawRoom', '重轉失敗：無法連線到伺服器'],
  ] as const)('%s 送出時同步拋錯也顯示無法連線、不 refetch 並解除 busy', async (label, action, message) => {
    vi.mocked(api[action]).mockImplementation(() => { throw new TypeError('sync throw') })
    const state = pending(HOST)
    await renderRoom(state)
    fireEvent.click(button(label))
    await settle()

    expect(alertText()).toBe(message)
    expect(state.refetch).not.toHaveBeenCalled()
    expect(button(label).disabled).toBe(false)
  })

  it.each([
    ['確認就吃這家', '確認成功，但重新載入失敗，請重新整理頁面'],
    ['排除這家並重轉', '重轉成功，但重新載入失敗，請重新整理頁面'],
  ] as const)('%s 成功但 refetch 拋錯時如實回報並解除 busy', async (label, message) => {
    await renderRoom(pending(HOST, { refetch: vi.fn(async () => { throw new Error('offline') }) }))
    fireEvent.click(button(label))
    await settle()

    expect(alertText()).toBe(message)
    expect(button(label).disabled).toBe(false)
  })

  it('房間版本已前進時不顯示舊抽選或操作', async () => {
    await renderRoom(pending(HOST, { room: makeRoom({ status: 'pending', draw_version: 5 }) }))
    expect(screen.getByText('正在同步最新抽選結果…')).toBeTruthy()
    expect(queryButton('確認就吃這家')).toBeNull()
    expect(queryButton('排除這家並重轉')).toBeNull()
  })
})

describe('RoomPage 換階段', () => {
  it.each([
    ['pending@3', true], // 排光回 lobby：3 → 4
    ['pending@2', false], // 排光後又搜尋、修改條件才回 lobby：2 → 4，最後一次回 lobby 不是排光
    ['candidates@3', false],
    [null, false],
  ] as const)('重整／重開分頁時拿這台記下的階段來比（記下 %s）：search_version 剛好 +1 才補說明，且不搶焦點不捲動',
    async (stored, warned) => {
      if (stored) localStorage.setItem('room-stage:room-1', stored)
      const scrollBy = vi.fn()
      vi.stubGlobal('scrollBy', scrollBy)
      const frames = captureFrames()
      // 焦點在 body、階段開頭被標頭蓋住：換成一般換階段會捲動也會移焦點，剛載入時兩者都不該發生
      layout(40)
      // 真實的兩段掛載：先是房間還沒載到（room 為 null），之後才是 lobby
      const state = pending(GUEST, { room: null, draw: null })
      await renderRoom(state)
      push({ ...state, room: makeRoom({ status: 'lobby', search_version: 4 }) })
      act(() => frames.flush())

      expect(localStorage.getItem('room-stage:room-1')).toBe('lobby@4')
      expect(screen.queryByText(EXHAUSTED) !== null).toBe(warned)
      expect(document.activeElement).toBe(document.body)
      expect(scrollBy).not.toHaveBeenCalled()
    })

  it('從抽中待確認回到準備階段時告訴全房原因；別的換階段只收掉這則、不動其他警告', async () => {
    // 從 from（記下 search_version）換到 to；search_version 進 lobby 時 +1，其他換階段不變
    async function transition(from: Room['status'], to: Room['status'], fromVersion = 3,
      toVersion = to === 'lobby' ? 4 : 3, me = GUEST) {
      const state = inStage(from, me, { room: makeRoom({ status: from, search_version: fromVersion }) })
      const view = await renderRoom(state)
      push({ ...state, room: makeRoom({ status: to, search_version: toVersion }) })
      return view
    }

    let view = await transition('pending', 'lobby')
    expect(screen.getByText(EXHAUSTED)).toBeTruthy()
    // 重新搜尋後：收掉排光提示
    push(inStage('candidates', GUEST, { room: makeRoom({ status: 'candidates', search_version: 4 }) }))
    expect(screen.queryByText(EXHAUSTED)).toBeNull()
    view.unmount()
    localStorage.clear()

    // 沒重新掛載、但一次跳過好幾步（手機鎖屏後喚醒）：排光後又搜尋、修改條件才回 lobby，不是排光
    view = await transition('pending', 'lobby', 2, 4)
    expect(screen.queryByText(EXHAUSTED)).toBeNull()
    view.unmount()
    localStorage.clear()

    view = await transition('candidates', 'lobby') // 修改條件回準備階段：不講
    expect(screen.queryByText(EXHAUSTED)).toBeNull()
    view.unmount()
    localStorage.clear()

    // 換階段只收排光那則：搜尋的快取警告留著
    const cached = '外部搜尋暫時失敗，本次使用 30 天內的快取資料'
    vi.mocked(api.searchRoom).mockResolvedValue({ error: null, warning: cached })
    const state = lobbyReady()
    await renderRoom(state)
    fireEvent.click(button('開始搜尋餐廳'))
    await settle()
    expect(screen.getByText(cached)).toBeTruthy()
    push({ ...state, room: makeRoom({ status: 'candidates' }), candidates: [candidate('r1')] })
    expect(screen.getByText(cached)).toBeTruthy()
  })

  type Focus = 'body' | 'header' | 'dialog'
  it.each([
    { from: 'voting', to: 'pending', top: 40, focus: 'body', scroll: -72, heading: true },
    { from: 'voting', to: 'pending', top: 300, focus: 'header', scroll: null, heading: false },
    { from: 'voting', to: 'pending', top: 40, focus: 'header', scroll: -72, heading: false },
    // 初選表決過半自動換階段時房主開著確認框：effect 當下焦點還在框裡，框卸載後才掉回 body
    { from: 'candidates', to: 'shortlisting', top: 300, focus: 'dialog', scroll: null, heading: true },
    { from: 'candidates', to: 'voting', top: 40, focus: 'body', scroll: null, heading: true },
  ] as Array<{ from: Room['status']; to: Room['status']; top: number; focus: Focus; scroll: number | null; heading: boolean }>)(
    '換階段 $from→$to（階段開頭 top $top、焦點在 $focus）：被標頭蓋住才捲回去、同一份清單換按鈕不捲；焦點掉在 body 才移到階段標題',
    async ({ from, to, top, focus, scroll, heading }) => {
      const scrollBy = vi.fn()
      vi.stubGlobal('scrollBy', scrollBy)
      const frames = captureFrames()
      layout(top)
      const state = inStage(from)
      await renderRoom(state)
      if (focus === 'header') button(/邀請碼 ABC123/).focus()
      if (focus === 'dialog') {
        fireEvent.click(button('修改條件'))
        expect(dialog().contains(document.activeElement)).toBe(true)
      }

      push({ ...state, room: makeRoom({ status: to }) })
      // 焦點檢查排在下一幀：確認框要等那次 commit 才卸載
      act(() => frames.flush())

      if (scroll === null) expect(scrollBy).not.toHaveBeenCalled()
      else expect(scrollBy).toHaveBeenCalledWith({ top: scroll, behavior: 'smooth' })
      const h1 = screen.getByRole('heading', { level: 1 })
      expect(h1.textContent).toContain('目前階段')
      expect(document.activeElement === h1).toBe(heading)
    })
})

describe('RoomPage 載入失敗（QA ISSUE-002）', () => {
  it('loadError 顯示重試而非「找不到房間」，按重試呼叫 refetch', async () => {
    const state = roomState(null, { loadError: true, myUserId: '' })
    await renderRoom(state)
    expect(document.body.textContent).not.toContain('找不到房間')
    expect(screen.getByText('房間載入失敗，請稍後再試')).toBeTruthy()
    fireEvent.click(button('重試'))
    expect(state.refetch).toHaveBeenCalled()
  })

  it('找不到房間時可回首頁，也可重試（token 刷新失敗造成的假 not-found 能自行復原）', async () => {
    const state = roomState(null, { notFound: true, myUserId: '' })
    await renderRoom(state)
    expect(screen.getByText('找不到房間，或你不是成員')).toBeTruthy()
    expect(screen.getByRole('link', { name: '回首頁' }).getAttribute('href')).toBe('/')
    fireEvent.click(button('重試'))
    expect(state.refetch).toHaveBeenCalled()
  })

  it('房間已載入時 loadError 顯示部分資料失敗並可重試', async () => {
    const state = lobby({ loadError: true })
    await renderRoom(state)
    expect(screen.getByText('部分資料載入失敗，畫面可能不完整')).toBeTruthy()
    fireEvent.click(button('重試'))
    expect(state.refetch).toHaveBeenCalled()
  })
})

describe('RoomPage lobby：房主免準備、房間設定與搜尋', () => {
  it('房主在 lobby 看不到「我準備好了」按鈕', async () => {
    await renderRoom(lobby())
    expect(queryButton('我準備好了')).toBeNull()
  })

  it('成員列表房主列不顯示「設定中」badge', async () => {
    await renderRoom(lobby())
    expect(screen.getAllByText('設定中')).toHaveLength(1)
  })

  it('所有非房主都 ready 時搜尋鈕可用，房主自己的 ready 不列入', async () => {
    await renderRoom(lobbyReady())
    expect(button('開始搜尋餐廳').disabled).toBe(false)
  })

  it('房內三組房間設定的 segmented control 都有至少 44px 的 class', async () => {
    await renderRoom(lobby())
    for (const label of ['熟悉', '平均', '探索', '馬上出發', '自訂時間', '關閉', '開啟']) {
      expect(button(label).className).toContain('min-h-11')
    }
  })

  it('任一非房主未 ready 時搜尋鈕 disabled 並講還差幾人，按下去也不送 /search', async () => {
    await renderRoom(lobby())
    expect(queryButton('開始搜尋餐廳')).toBeNull()
    const search = button('還有 1 人還沒準備好')
    expect(search.disabled).toBe(true)
    fireEvent.click(search)
    await settle()
    expect(api.searchRoom).not.toHaveBeenCalled()
  })

  it('搜尋前置儲存期間有人取消準備：不送 /search', async () => {
    const write = deferred<WriteResult>()
    mocks.memberWrite.mockReturnValueOnce(write.promise)
    const state = lobbyReady()
    await renderRoom(state)
    fireEvent.click(button('日式')) // 條件表單還有沒寫進去的修改：搜尋要先等它
    fireEvent.click(button('開始搜尋餐廳'))
    await settle()

    push({ ...state, members: [hostMember, guestMember({ ready: false })] })
    await act(async () => write.resolve({ error: null, count: 1 }))
    await settle()
    expect(api.searchRoom).not.toHaveBeenCalled()
  })

  it('solo host 不需要 ready 即可搜尋', async () => {
    await renderRoom(lobby({ members: [hostMember] }))
    expect(button('開始搜尋餐廳').disabled).toBe(false)
  })

  it('host 搜尋同時等待 ConditionsForm flush 與 room-setting write chain', async () => {
    const roomWrite = deferred<WriteResult>()
    const conditionsWrite = deferred<WriteResult>()
    mocks.roomsWrite.mockReturnValueOnce(roomWrite.promise)
    mocks.memberWrite.mockReturnValueOnce(conditionsWrite.promise)
    await renderRoom(lobbyReady())

    fireEvent.click(button('日式')) // 條件表單：debounce 中、還沒送出的修改
    // 改設定後馬上按搜尋（React 重繪、把搜尋鈕關起來之前）
    const familiar = button('熟悉')
    const search = button('開始搜尋餐廳')
    await act(async () => { familiar.click(); search.click() })
    await settle()
    expect(mocks.update).toHaveBeenCalledWith('room_members', expect.objectContaining({ cuisines: ['japanese'] }),
      { count: 'exact' }) // 搜尋把 debounce 中的條件立刻寫出去
    expect(api.searchRoom).not.toHaveBeenCalled()

    await act(async () => roomWrite.resolve({ error: null, count: 1 }))
    await settle()
    expect(api.searchRoom).not.toHaveBeenCalled()

    await act(async () => conditionsWrite.resolve({ error: null, count: 1 }))
    await settle()
    expect(api.searchRoom).toHaveBeenCalledTimes(1)
    expect(api.searchRoom).toHaveBeenCalledWith('room-1', {
      signal: expect.any(AbortSignal),
      onRequestStart: expect.any(Function),
    })
  })

  it('改地點階段不等待已卸載條件表單，lobby 仍維持儲存閘門', async () => {
    mocks.memberWrite.mockResolvedValueOnce({ error: null, count: 0 }) // 條件寫入被擋下
    const state = lobby({ room: makeRoom({ search_version: 2 }) })
    await renderRoom(state)
    fireEvent.click(button('日式'))
    fireEvent.click(button('在地圖選這裡'))
    fireEvent.click(button('確認用餐地點'))
    await settle()
    expect(api.chooseLocation).not.toHaveBeenCalled()

    push({ ...state, room: makeRoom({ status: 'relocating', search_version: 2 }) })
    fireEvent.click(button('在地圖選這裡'))
    fireEvent.click(button('確認新地點'))
    await settle()
    expect(api.chooseLocation).toHaveBeenCalledWith('room-1', mocks.picked.lat, mocks.picked.lng, 2)
  })

  it('改地點的前置儲存沒過：不送出、不 refetch、不另外顯示動作錯誤，按鈕解鎖可重試', async () => {
    mocks.memberWrite.mockResolvedValueOnce({ error: null, count: 0 }) // 條件寫入被擋下
    const state = lobby()
    await renderRoom(state)
    fireEvent.click(button('日式'))
    fireEvent.click(button('在地圖選這裡'))
    fireEvent.click(button('確認用餐地點'))
    await settle()

    expect(api.chooseLocation).not.toHaveBeenCalled()
    expect(state.refetch).not.toHaveBeenCalled()
    // 唯一的錯誤是條件表單自己的儲存失敗
    expect(screen.getAllByRole('alert').map(alert => alert.textContent))
      .toEqual(['儲存失敗：房間可能已開始選餐，條件已凍結'])
    expect(button('確認用餐地點').disabled).toBe(false)
  })

  it('換地點被伺服器拒絕：不記成現任出發點、確認鈕留著；成功後才收起', async () => {
    vi.mocked(api.chooseLocation).mockResolvedValueOnce('房間狀態已變更')
    const state = lobby()
    await renderRoom(state)
    fireEvent.click(button('在地圖選這裡'))
    fireEvent.click(button('確認用餐地點'))
    await settle()

    expect(api.chooseLocation).toHaveBeenCalledWith('room-1', mocks.picked.lat, mocks.picked.lng, 3)
    expect(alertText()).toBe('房間狀態已變更')
    expect(state.refetch).not.toHaveBeenCalled()
    expect(localStorage.getItem('room-departure:room-1')).toBeNull()
    expect(button('確認用餐地點').disabled).toBe(false) // 還沒換成：可以再送一次

    fireEvent.click(button('確認用餐地點'))
    await settle()
    expect(api.chooseLocation).toHaveBeenCalledTimes(2)
    expect(state.refetch).toHaveBeenCalledOnce()
    expect(queryButton('確認用餐地點')).toBeNull() // 現任就是這個點：沒有東西可確認
  })

  it('preflight pending 時 unmount，晚到結果不送 search、不啟動慢搜尋計時', async () => {
    const write = deferred<WriteResult>()
    mocks.memberWrite.mockReturnValueOnce(write.promise)
    const view = await renderRoom(lobbyReady())
    const timers = vi.spyOn(globalThis, 'setTimeout')
    fireEvent.click(button('日式'))
    fireEvent.click(button('開始搜尋餐廳'))
    await settle()

    view.unmount()
    await act(async () => write.resolve({ error: null, count: 1 }))
    await settle()
    expect(api.searchRoom).not.toHaveBeenCalled()
    expect(timers).not.toHaveBeenCalledWith(expect.any(Function), 3000)
  })

  it('request-start callback 精確在 3000ms 顯示 truthful 的慢搜尋狀態，結束後收掉', async () => {
    vi.useFakeTimers()
    const result = deferred<api.SearchOutcome>()
    vi.mocked(api.searchRoom).mockImplementation(async (_roomId, options) => {
      options?.onRequestStart?.()
      return result.promise
    })
    await renderRoom(lobbyReady())
    fireEvent.click(button('開始搜尋餐廳'))
    await settle()
    expect(api.searchRoom).toHaveBeenCalledTimes(1)
    expect(screen.queryByText(SLOW_SEARCH)).toBeNull()

    await act(() => vi.advanceTimersByTimeAsync(2999))
    expect(screen.queryByText(SLOW_SEARCH)).toBeNull()
    await act(() => vi.advanceTimersByTimeAsync(1))
    expect(screen.getByText(SLOW_SEARCH).getAttribute('role')).toBe('status')

    await act(async () => result.resolve({ error: null, warning: null }))
    await settle()
    expect(screen.queryByText(SLOW_SEARCH)).toBeNull()
  })

  it('欄位 A 寫入失敗後，欄位 B 成功仍阻擋搜尋，直到 A 重試成功', async () => {
    mocks.roomsWrite
      .mockResolvedValueOnce({ error: { message: 'exploration failed' }, count: 0 })
      .mockResolvedValueOnce({ error: null, count: 1 })
      .mockResolvedValueOnce({ error: null, count: 1 })
    await renderRoom(lobbyReady())

    fireEvent.click(button('熟悉'))
    await settle()
    fireEvent.click(button('開啟'))
    await settle()
    expect(button('開始搜尋餐廳').disabled).toBe(true)
    fireEvent.click(button('開始搜尋餐廳'))
    await settle()
    expect(api.searchRoom).not.toHaveBeenCalled()

    fireEvent.click(button('熟悉'))
    await settle()
    expect(button('開始搜尋餐廳').disabled).toBe(false)
    fireEvent.click(button('開始搜尋餐廳'))
    await settle()
    expect(api.searchRoom).toHaveBeenCalledTimes(1)
  })

  it('錯誤和警告同時出現（降級的 422）：兩則橫幅都捲到最上面那則錯誤，不捲警告自己', async () => {
    vi.mocked(api.searchRoom).mockResolvedValue({
      error: '找不到符合條件的餐廳，請放寬條件', warning: '外部搜尋暫時失敗，本次使用 30 天內的快取資料' })
    const reveal = vi.spyOn(Element.prototype, 'scrollIntoView')
    await renderRoom(lobbyReady())
    fireEvent.click(button('開始搜尋餐廳'))
    await settle()

    const error = screen.getByRole('alert')
    expect(error.textContent).toBe('找不到符合條件的餐廳，請放寬條件')
    expect(screen.getByText('外部搜尋暫時失敗，本次使用 30 天內的快取資料')).toBeTruthy()
    expect(reveal).toHaveBeenCalledTimes(2)
    expect(reveal.mock.contexts).toEqual([error, error])
    expect(reveal).toHaveBeenCalledWith({ block: 'nearest', behavior: 'smooth' })
  })

  it('搜尋中：搜尋鈕 disabled 顯示「搜尋中…」，房間設定與條件表單一起停用', async () => {
    const result = deferred<api.SearchOutcome>()
    vi.mocked(api.searchRoom).mockReturnValue(result.promise)
    await renderRoom(lobbyReady())
    fireEvent.click(button('開始搜尋餐廳'))
    await settle()

    expect(button('搜尋中…').disabled).toBe(true)
    for (const label of ['熟悉', '平均', '探索', '馬上出發', '自訂時間', '關閉', '開啟', '日式']) {
      expect(button(label).disabled, label).toBe(true)
    }

    await act(async () => result.resolve({ error: null, warning: null }))
    await settle()
    expect(button('開始搜尋餐廳').disabled).toBe(false)
    expect(button('熟悉').disabled).toBe(false)
  })

  it('成員視角仍有「我準備好了」按鈕', async () => {
    await renderRoom(lobby({ myUserId: GUEST }))
    expect(button('我準備好了')).toBeTruthy()
  })

  it.each([
    ['lobby', false, '設好條件後，按最下方「我準備好了」'],
    ['lobby', true, '已準備好，等房主開始搜尋'],
    ['candidates', false, '候選出爐了，等房主開始投票'],
    ['voting', false, '投完票後，等房主啟動轉盤'],
    ['pending', false, '等房主確認，或排除這家重轉'],
  ] as const)('成員視角在 %s（ready=%s）講清楚在等誰', async (status, ready, hint) => {
    await renderRoom(roomState({ status }, { myUserId: GUEST,
      members: [hostMember, guestMember({ ready })], candidates: [candidate('r1')] }))
    expect(screen.getByText(hint).getAttribute('role')).toBe('status')
  })

  it('候選多到開放初選表決時，提示成員可以先表決', async () => {
    const many = Array.from({ length: 7 }, (_, i) => candidate(`r${i}`))
    await renderRoom(roomState({ status: 'candidates' }, { myUserId: GUEST, candidates: many }))
    const text = document.body.textContent
    expect(text).toContain('候選很多：可以先表決要不要初選')
    expect(text).not.toContain('候選出爐了，等房主開始投票')
  })

  it('自己準備好但還有人沒準備：講在等其他人，不說在等房主', async () => {
    await renderRoom(lobby({ myUserId: GUEST,
      members: [hostMember, guestMember({ ready: true }), member('user-c', '小C')] }))
    const text = document.body.textContent
    expect(text).toContain('已準備好，還在等 1 人')
    expect(text).not.toContain('等房主開始搜尋')
  })

  it('候選全滅時只留死路橫幅，不叫成員等轉盤', async () => {
    await renderRoom(roomState({ status: 'voting' }, { myUserId: GUEST,
      candidates: [candidate('r1', { status: 'excluded', exclusion_kinds: ['veto'] })] }))
    const text = document.body.textContent
    expect(text).toContain('候選已全數被否決')
    expect(text).not.toContain('等房主啟動轉盤')
  })

  it('房主視角、或還不知道自己是誰時不顯示等待提示', async () => {
    const host = await renderRoom(roomState({ status: 'candidates' }, { candidates: [candidate('r1')] }))
    expect(document.body.textContent).not.toContain('等房主')
    host.unmount()

    await renderRoom(roomState({ status: 'candidates' }, { myUserId: '', candidates: [candidate('r1')] }))
    expect(document.body.textContent).not.toContain('等房主')
  })

  it('uid 還沒讀到時不把房主當成員提示', async () => {
    await renderRoom(lobby({ myUserId: '' }))
    expect(document.body.textContent).not.toContain('我準備好了」')
  })

  it('lobby 成員視角：房主的設定收成一行摘要，沒有開關', async () => {
    await renderRoom(lobby({ myUserId: GUEST }))
    expect(queryButton('關閉')).toBeNull()
    expect(queryButton('平均')).toBeNull()
    expect(document.body.textContent).toContain('探索檔位：平均・用餐時間：')
    expect(document.body.textContent).toContain('・菜系過濾：關閉')
  })

  // eng review 5A：寫入路徑防線——點了沒寫進 DB（或漏 count 防線）這條會紅
  it('host 點「開啟」以 count:exact 寫入 cuisine_filter', async () => {
    await renderRoom(lobby())
    fireEvent.click(button('開啟'))
    await settle()
    expect(mocks.update).toHaveBeenCalledWith('rooms', { cuisine_filter: true }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('rooms', 'id', 'room-1')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('cuisine_filter 寫入 count 0（RLS 擋下）時顯示菜系過濾錯誤', async () => {
    mocks.roomsWrite.mockResolvedValue({ error: null, count: 0 })
    await renderRoom(lobby())
    fireEvent.click(button('開啟'))
    await settle()
    expect(mocks.update).toHaveBeenCalledWith('rooms', { cuisine_filter: true }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('rooms', 'id', 'room-1')
    expect(alertText()).toBe('菜系過濾更新失敗')
  })

  it('host 點探索檔位鎖定房間 id；count 0 時顯示探索檔位錯誤', async () => {
    mocks.roomsWrite.mockResolvedValue({ error: null, count: 0 })
    await renderRoom(lobby())
    fireEvent.click(button('熟悉'))
    await settle()
    expect(mocks.update).toHaveBeenCalledWith('rooms', { exploration: 'familiar' }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('rooms', 'id', 'room-1')
    expect(alertText()).toBe('探索檔位更新失敗')
  })
})

describe('RoomPage 候選出爐：房主動作', () => {
  it('candidates 只有房主看得到「修改條件」與「開始投票」', async () => {
    const host = await renderRoom(inStage('candidates'))
    expect(button('修改條件')).toBeTruthy()
    expect(button('開始投票')).toBeTruthy()
    host.unmount()

    await renderRoom(inStage('candidates', GUEST))
    expect(queryButton('修改條件')).toBeNull()
    expect(queryButton('開始投票')).toBeNull()
  })

  it('開始投票：同一瞬間連點只送一次（ref 鎖），等 refetch 完成前顯示處理中並停用', async () => {
    const reload = deferred<void>()
    const state = inStage('candidates', HOST, { refetch: vi.fn(() => reload.promise) })
    await renderRoom(state)
    const start = button('開始投票')
    // busy state 要等重繪才生效：同一瞬間的兩下要靠 ref 鎖擋
    await act(async () => { start.click(); start.click() })
    await settle()

    expect(api.startVoting).toHaveBeenCalledOnce()
    expect(api.startVoting).toHaveBeenCalledWith('room-1')
    expect(button('處理中…').disabled).toBe(true)
    expect(button('修改條件').disabled).toBe(true)

    await act(async () => reload.resolve())
    expect(button('開始投票').disabled).toBe(false)
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('開始投票已送出成功、只是重新載入失敗：如實說成功了，請使用者重新整理', async () => {
    await renderRoom(inStage('candidates', HOST, { refetch: vi.fn(async () => { throw new Error('offline') }) }))
    fireEvent.click(button('開始投票'))
    await settle()

    expect(api.startVoting).toHaveBeenCalledWith('room-1')
    expect(alertText()).toBe('開始投票成功，但重新載入失敗，請重新整理頁面')
    expect(button('開始投票').disabled).toBe(false)
  })

  it('修改條件先開站內確認框；按取消不送 request、焦點回到觸發鈕', async () => {
    const frames = captureFrames()
    await renderRoom(inStage('candidates'))
    const trigger = button('修改條件')
    fireEvent.click(trigger)
    expect(within(dialog()).getByRole('heading', { name: '修改條件？' })).toBeTruthy()
    expect(dialog().textContent).toContain('修改條件會清除目前候選，並請所有成員重新準備。')
    expect(trigger.closest('.min-h-screen')!.hasAttribute('inert')).toBe(true) // 框開著：背景 inert
    expect(api.editConditions).not.toHaveBeenCalled()

    fireEvent.click(inDialog('取消'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.editConditions).not.toHaveBeenCalled()
    expect(document.activeElement).not.toBe(trigger) // 同步聚焦會被還沒解除的 inert 吃掉
    act(() => frames.flush()) // 下一幀才還原焦點
    expect(document.activeElement).toBe(trigger)

    // 按確定：關框並送出
    fireEvent.click(trigger)
    fireEvent.click(inDialog('清除候選並修改'))
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(api.editConditions).toHaveBeenCalledWith('room-1')
  })

  it('修改條件 busy ref 擋連點，成功只 refetch 一次', async () => {
    const sent = deferred<string | null>()
    vi.mocked(api.editConditions).mockReturnValue(sent.promise)
    const state = inStage('candidates')
    await renderRoom(state)
    fireEvent.click(button('修改條件'))
    const confirm = inDialog('清除候選並修改')
    await act(async () => { confirm.click(); confirm.click() })
    await settle()
    expect(api.editConditions).toHaveBeenCalledTimes(1)
    expect(api.editConditions).toHaveBeenCalledWith('room-1')
    expect(button('處理中…').disabled).toBe(true)

    await act(async () => sent.resolve(null))
    await settle()
    expect(state.refetch).toHaveBeenCalledTimes(1)
  })

  it('修改條件錯誤顯示在既有 action alert 且不 refetch', async () => {
    vi.mocked(api.editConditions).mockResolvedValue('房間狀態已變更')
    const state = inStage('candidates')
    await renderRoom(state)
    fireEvent.click(button('修改條件'))
    fireEvent.click(inDialog('清除候選並修改'))
    await settle()

    expect(alertText()).toBe('房間狀態已變更')
    expect(state.refetch).not.toHaveBeenCalled()
  })
})

// 初選（ADR-0010）：這裡只驗 RoomPage／CandidateList 的接線，門檻與計數規則由 lib/shortlist.test.ts 窮舉
describe('初選（Shortlist）', () => {
  const rids = ['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'] // 2 人 × 3 = 6，7 家才過門檻
  const picks = (userId: string, ids: string[]) =>
    ids.map(restaurant_id => ({ room_id: 'room-1', user_id: userId, restaurant_id }))

  function shortlist(status: Room['status'], over: Partial<RoomState> = {}) {
    return roomState({ status }, {
      members: [member(HOST, '房主', { ready: true }), guestMember({ ready: true })],
      candidates: rids.map(id => candidate(id, { probability: 0.1 })), ...over,
    })
  }

  it('候選出爐：kept 多於成員數 × 3 才對全員顯示初選表決，排除的店不算', async () => {
    const open = await renderRoom(shortlist('candidates', {
      myUserId: GUEST, shortlistVotes: [{ room_id: 'room-1', user_id: GUEST }] }))
    expect(screen.getByRole<HTMLInputElement>('checkbox', { name: '我想先初選' }).checked).toBe(true)
    expect(screen.getByText('目前 1/2 票，需 2 票才會進入初選')).toBeTruthy()
    open.unmount()

    await renderRoom(shortlist('candidates', {
      candidates: [...rids.slice(0, 6).map(id => candidate(id)), candidate('r7', { status: 'excluded' })] }))
    expect(screen.queryByRole('checkbox', { name: '我想先初選' })).toBeNull()
  })

  it('表決送出後 refetch；錯誤原文顯示', async () => {
    const state = shortlist('candidates')
    await renderRoom(state)
    fireEvent.click(screen.getByRole('checkbox', { name: '我想先初選' }))
    await settle()
    expect(api.voteShortlist).toHaveBeenCalledWith('room-1', true, 3)
    expect(state.refetch).toHaveBeenCalledOnce()

    // 上一次動作結束就解鎖：第二次照樣送出
    vi.mocked(api.voteShortlist).mockResolvedValueOnce('候選沒有超過成員數的 3 倍，不需要初選')
    fireEvent.click(screen.getByRole('checkbox', { name: '我想先初選' }))
    await settle()
    expect(api.voteShortlist).toHaveBeenCalledTimes(2)
    expect(alertText()).toBe('候選沒有超過成員數的 3 倍，不需要初選')
  })

  it('表決已送出成功、只是重新載入失敗：如實說成功了，不說無法連線', async () => {
    await renderRoom(shortlist('candidates', { refetch: vi.fn(async () => { throw new Error('offline') }) }))
    fireEvent.click(screen.getByRole('checkbox', { name: '我想先初選' }))
    await settle()
    expect(api.voteShortlist).toHaveBeenCalledWith('room-1', true, 3)
    expect(alertText()).toBe('初選表決成功，但重新載入失敗，請重新整理頁面')
  })

  it.each([
    ['初選表決', 'candidates', '我想先初選', 'voteShortlist'],
    ['改地點表決', 'voting', '我想換地點', 'voteLocation'],
  ] as const)('%s 同一瞬間連點只送一次', async (_label, status, name, send) => {
    await renderRoom(shortlist(status))
    const box = screen.getByRole('checkbox', { name })
    await act(async () => { box.click(); box.click() })
    await settle()
    expect(api[send]).toHaveBeenCalledOnce()
  })

  it('初選中：每位成員（含房主）顯示 kept 圈選數，取代準備狀態', async () => {
    await renderRoom(shortlist('shortlisting', {
      // 小B 的 gone 不是候選，不算數
      shortlistPicks: [...picks(HOST, ['r1', 'r2', 'r3']), ...picks(GUEST, ['r1', 'gone'])] }))
    const text = document.body.textContent
    expect(text).toContain('已圈 3 家')
    expect(text).toContain('圈選中 1/3')
    expect(text).not.toContain('已準備')
    expect(text).toContain('全員圈滿 3 家後房主可以開始投票；沒人圈的店不進轉盤')
  })

  it('初選中房主：有人沒圈滿時開始投票 disabled 並說明人數，圈滿後可開始', async () => {
    const waiting = await renderRoom(shortlist('shortlisting', {
      shortlistPicks: [...picks(HOST, ['r1', 'r2', 'r3']), ...picks(GUEST, ['r1'])] }))
    expect(button('還有 1 人沒圈滿 3 家').disabled).toBe(true)
    expect(queryButton('開始投票')).toBeNull()
    waiting.unmount()

    const reload = deferred<void>()
    const state = shortlist('shortlisting', { refetch: vi.fn(() => reload.promise),
      shortlistPicks: [...picks(HOST, ['r1', 'r2', 'r3']), ...picks(GUEST, ['r1', 'r4', 'r5'])] })
    await renderRoom(state)
    expect(button('開始投票').disabled).toBe(false)
    fireEvent.click(button('開始投票'))
    await settle()
    expect(api.startVoting).toHaveBeenCalledWith('room-1')
    expect(state.refetch).toHaveBeenCalledOnce()
    // 成功後先 refetch 才解鎖：Realtime 到之前按鈕不能再按
    expect(button('處理中…').disabled).toBe(true)

    await act(async () => reload.resolve())
    expect(button('開始投票').disabled).toBe(false)
    expect(button('修改條件')).toBeTruthy()
  })

  it('初選中成員：可圈選但看不到房主控制項；圈選錯誤原文顯示', async () => {
    const togglePick = vi.fn(async (_rid: string) => '每人最多圈選 5 家')
    await renderRoom(shortlist('shortlisting', { myUserId: GUEST, togglePick,
      shortlistPicks: [...picks(GUEST, ['r1', 'r2']), ...picks(HOST, ['r1'])] }))
    expect(queryButton('取消初選')).toBeNull()
    expect(queryButton('修改條件')).toBeNull()
    expect(screen.getByText('已圈 2/5（至少 3 家）')).toBeTruthy()
    const pick = (name: string) => within(candidateRow(name)).getByRole('button', { name: /^圈選/ })
    expect(pick('店r1').textContent).toBe('圈選（2 人）')
    expect(pick('店r2').textContent).toBe('圈選（1 人）')
    expect(pressed(pick('店r2'))).toBe('true')
    expect(pressed(pick('店r3'))).toBe('false')

    fireEvent.click(pick('店r3'))
    await settle()
    expect(togglePick).toHaveBeenCalledWith('r3')
    expect(alertText()).toBe('每人最多圈選 5 家')
  })

  it('取消初選先開站內確認框；確定才送並 refetch', async () => {
    const state = shortlist('shortlisting')
    await renderRoom(state)
    fireEvent.click(button('取消初選'))
    expect(within(dialog()).getByRole('heading', { name: '取消初選？' })).toBeTruthy()
    expect(dialog().textContent).toContain('取消初選會清除所有人的圈選，回到候選出爐。')
    expect(api.cancelShortlist).not.toHaveBeenCalled()

    fireEvent.click(inDialog('清除圈選'))
    await settle()
    expect(api.cancelShortlist).toHaveBeenCalledWith('room-1')
    expect(state.refetch).toHaveBeenCalledOnce()
  })

  // 瀏覽器裡背景 inert，但確定鈕按下到重繪之間還有一拍：這時再按到「取消初選」不能重開確認框
  it('取消初選送出中：再按取消初選不會重開確認框', async () => {
    const sent = deferred<string | null>()
    vi.mocked(api.cancelShortlist).mockReturnValue(sent.promise)
    await renderRoom(shortlist('shortlisting'))
    const cancel = button('取消初選')
    fireEvent.click(cancel)
    const confirm = inDialog('清除圈選')
    await act(async () => { confirm.click(); cancel.click() })
    await settle()

    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button('處理中…').disabled).toBe(true)
    await act(async () => sent.resolve(null))
    await settle()
    expect(api.cancelShortlist).toHaveBeenCalledOnce()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

// QA：房間頁左上 logo 按下去靜默送出 leave（ADR-0007 回首頁＝離席），要先確認。
// Codex review r4：文案改成點擊當下 fetchLeaveRooms() 重查，不再讀 useRoom 的 room／members
//（前者在 rooms 查詢失敗時會停在過期快照，後者漏報殘留房籍）。
// leaveNotice 本身的分歧規則由 lib/leaveNotice.test.ts 窮舉，這裡只驗 RoomPage 的接線。
describe('回首頁離席確認', () => {
  const leaveRow = (id: string, code: string, status: Room['status'], hostId = 'someone-else') =>
    ({ room_id: id, rooms: { code, status, host_id: hostId } })
  const inRoom = (status: Room['status'] = 'voting') =>
    mocks.memberRows.mockResolvedValue({ data: [leaveRow('room-1', 'ABC123', status)], error: null })

  async function openLeave() {
    fireEvent.click(homeLink())
    return screen.findByRole('dialog')
  }

  it('點 header 回首頁不導航，改當場查房籍後開確認', async () => {
    inRoom('voting')
    await renderRoom(lobby())
    expect(screen.queryByRole('dialog')).toBeNull()
    fireEvent.click(homeLink())
    expect(homeLink().getAttribute('aria-busy')).toBe('true')

    const leave = await screen.findByRole('dialog')
    expect(within(leave).getByRole('heading', { name: '離開房間？' })).toBeTruthy()
    expect(leave.textContent).toContain('你目前還在房間 ABC123 裡')
    // 人數與房主身分來自查詢：1 人、host_id 不是自己
    for (const line of leaveNotice('voting', 1, 'ABC123', false)) expect(leave.textContent).toContain(line)
    expect(mocks.from).toHaveBeenCalledWith('room_members')
    expect(screen.queryByText(/^首頁/)).toBeNull()
    expect(homeLink().getAttribute('aria-busy')).toBe('false')
  })

  // 查房籍期間背景還沒 inert，可能先開了「修改條件」確認框：兩個 dialog 不能疊在一起
  it('查房籍期間先開了確認框：房籍回來後只留離房框', async () => {
    const rows = deferred<SelectResult>()
    mocks.memberRows.mockReturnValueOnce(rows.promise)
    await renderRoom(inStage('candidates'))
    fireEvent.click(homeLink())
    fireEvent.click(button('修改條件'))
    expect(within(dialog()).getByRole('heading', { name: '修改條件？' })).toBeTruthy()

    await act(async () => rows.resolve({ data: [leaveRow('room-1', 'ABC123', 'candidates')], error: null }))
    await settle()
    const dialogs = screen.getAllByRole('dialog')
    expect(dialogs).toHaveLength(1)
    expect(within(dialogs[0]).getByRole('heading', { name: '離開房間？' })).toBeTruthy()
  })

  // useRoom 的 refetch 只在查到列時更新 room（查無列才清成 null）——rooms 查詢暫時失敗／Realtime 斷線時
  // room 會停在過期物件。文案若讀它，lobby→voting 之後仍會承諾「可用邀請碼重新加入」
  it('文案用查回來的 status，不用 useRoom 的過期 room 快照', async () => {
    mocks.memberRows.mockResolvedValue({
      data: [leaveRow('room-1', 'ABC123', 'voting'), leaveRow('room-1', 'ABC123', 'voting')], error: null })
    await renderRoom(lobby()) // useRoom 仍宣稱 status = 'lobby'
    const leave = await openLeave()
    expect(leave.textContent).toContain('你的投票會即刻作廢，候選盤面會重新計算')
    expect(leave.textContent).not.toContain('之後可用邀請碼重新加入') // lobby 才有的承諾
  })

  // POST /api/leave 是全退不挑房：殘留房籍（舊房 leave 逾時後又建新房）也會被退掉
  it('殘留房籍一起列出，各有回房入口（leave 是全退）', async () => {
    mocks.memberRows.mockResolvedValue({
      data: [leaveRow('room-1', 'ABC123', 'voting'), leaveRow('room-9', 'OLD999', 'lobby')], error: null })
    await renderRoom(lobby())
    const leave = await openLeave()
    expect(leave.textContent).toContain('你目前在 2 個房間裡，回首頁會一次全部離開')
    expect(leave.textContent).toContain('房間 ABC123')
    expect(leave.textContent).toContain('房間 OLD999')
    expect(within(leave).getByRole('link', { name: '回到 OLD999' }).getAttribute('href')).toBe('/room/room-9')
  })

  it('房籍查詢失敗改用保守文案，不假裝知道後果', async () => {
    mocks.memberRows.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await renderRoom(lobby())
    const leave = await openLeave()
    expect(leave.textContent).toContain('房間現況查不到')
    expect(leave.textContent).not.toContain('可用邀請碼重新加入')
    expect(leave.textContent).not.toContain('會直接被刪除')
  })

  it('查到房籍已消失：直接導航，不跳確認', async () => {
    mocks.memberRows.mockResolvedValue({ data: [], error: null })
    await renderRoom(lobby())
    fireEvent.click(homeLink())
    expect(await screen.findByText('首頁')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // 上一頁回到房內時首頁的末位退房還在飛（冷啟動）：當場查會誤問、等它則按鈕無聲卡住
  it('首頁的退房還在飛：不查房籍，直接回首頁', async () => {
    inRoom('pending')
    vi.mocked(api.pendingLeave).mockReturnValue(new Promise<void>(() => {}))
    await renderRoom(lobby())
    fireEvent.click(homeLink())
    expect(await screen.findByText('首頁')).toBeTruthy()
    expect(mocks.from).not.toHaveBeenCalledWith('room_members')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // aria-busy 擋不住點擊；兩次點擊之間房籍會變（多分頁是 ADR-0007 承認的情境）
  it('晚到的舊「沒有房間」回應不得跳過剛開好的 dialog', async () => {
    const first = deferred<SelectResult>()
    mocks.memberRows.mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ data: [leaveRow('room-9', 'NEW999', 'lobby')], error: null })
    await renderRoom(lobby())
    fireEvent.click(homeLink())
    fireEvent.click(homeLink())
    const leave = await screen.findByRole('dialog')
    expect(leave.textContent).toContain('NEW999')

    await act(async () => first.resolve({ data: [], error: null }))
    await settle()
    expect(screen.queryByText(/^首頁/)).toBeNull() // 舊回應沒有繞過 dialog 直接離席
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(homeLink().getAttribute('aria-busy')).toBe('false')
  })

  it('較早的點擊先回來也不算數：不導航、不收掉查詢中狀態，由最後一次點擊負責', async () => {
    const second = deferred<SelectResult>()
    mocks.memberRows.mockResolvedValueOnce({ data: [], error: null }).mockReturnValueOnce(second.promise)
    await renderRoom(lobby())
    fireEvent.click(homeLink())
    fireEvent.click(homeLink())
    await settle()
    expect(screen.queryByText(/^首頁/)).toBeNull()
    expect(homeLink().getAttribute('aria-busy')).toBe('true')

    await act(async () => second.resolve({ data: [leaveRow('room-9', 'NEW999', 'lobby')], error: null }))
    await settle()
    expect(dialog().textContent).toContain('NEW999')
    expect(homeLink().getAttribute('aria-busy')).toBe('false')
  })

  // PR #17 回歸：背景整塊帶著 inert（fixed 遮罩對 tab 順序沒用，只好整塊 inert），
  // 而 setLeaveDialog(null) 不同步 flush——同一輪呼叫 focus() 時觸發元素還在 inert
  // 子樹內，瀏覽器直接忽略，焦點掉回 document.body。所以斷言的是「延後」這件事本身：
  // 關閉當下不得聚焦，要等 rAF 那一拍（inert 已隨 commit 移除）才還原。
  it('關閉後的焦點還原排到 rAF，不在還帶著 inert 的同一輪呼叫', async () => {
    inRoom('voting')
    const frames = captureFrames()
    await renderRoom(lobby())
    let leave = await openLeave()
    expect(document.activeElement).toBe(inDialog('取消')) // autoFocus 落在安全的那顆

    fireEvent.click(inDialog('取消'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).not.toBe(homeLink()) // 這一輪背景還是 inert，現在聚焦只會被忽略
    expect(frames.pending).toBe(1)
    act(() => frames.flush())
    expect(document.activeElement).toBe(homeLink()) // 下一幀 inert 已移除，這次才真的聚焦得到

    // Esc 走同一條 closeLeave（實測就是 Esc 關閉後 activeElement 掉回 body）
    leave = await openLeave()
    fireEvent.keyDown(within(leave).getByRole('button', { name: '取消' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).not.toBe(homeLink())
    expect(frames.pending).toBe(1)
    act(() => frames.flush())
    expect(document.activeElement).toBe(homeLink())
  })

  it('確認鍵是真正導航的連結，且帶「已確認」旗標避免首頁再問一次', async () => {
    inRoom('voting')
    await renderRoom(lobby())
    const leave = await openLeave()
    fireEvent.click(within(leave).getByRole('link', { name: '離開房間' }))
    expect(await screen.findByText('首頁 {"leaveConfirmed":true}')).toBeTruthy()
  })

  // fixed 遮罩擋得住指標，對 tab 順序毫無作用：背景整塊要 inert，且 dialog 不能在裡面
  it('dialog 開著時背景 inert，dialog 本身在 inert 子樹外', async () => {
    inRoom('voting')
    await renderRoom(lobby())
    const background = homeLink().closest('.min-h-screen')!
    expect(background.hasAttribute('inert')).toBe(false)

    const leave = await openLeave()
    expect(background.hasAttribute('inert')).toBe(true)
    expect(background.contains(leave)).toBe(false)
    // 背景真的含著會被鍵盤觸發的控制項——斷言不是空的
    expect(within(background as HTMLElement).getAllByRole('button').length).toBeGreaterThan(0)
  })
})

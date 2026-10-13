// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import * as api from '../lib/api'
import { leaveNotice } from '../lib/leaveNotice'
import type { Room } from '../lib/types'
import { getUid } from '../lib/uid'
import { captureFrames, deferred, settle } from '../test/dom'
import HistoryPage from './HistoryPage'

// 足跡頁的「回首頁」同樣＝離席（ADR-0007，HomePage mount 無條件 leaveRooms），點下去要先查房籍再確認。
// 行為測試：真的 React hooks 跑在 jsdom 上，只在模組邊界 mock——lib/supabase（足跡與房籍查詢）、
// lib/uid、lib/api（首頁退房是否還在飛）。

type SelectResult = { data: unknown[] | null; error: { message: string } | null }
type HistoryResult = SelectResult & { count: number | null }

const mocks = vi.hoisted(() => {
  const memberRows = vi.fn(async (): Promise<SelectResult> => ({ data: [], error: null }))
  const history = vi.fn(async (): Promise<HistoryResult> => ({ data: [], error: null, count: 0 }))
  const ratingUpdate = vi.fn<(patch: unknown, options: unknown) => void>()
  const ratingWrite = vi.fn(async (): Promise<{ error: null; count: number }> => ({ error: null, count: 1 }))
  // 查詢鏈：後面可接任意 eq／is／order／limit，整條鏈被 await 時才取結果
  function chain(result: () => Promise<unknown>) {
    const self = {
      eq: () => self,
      is: () => self,
      order: () => self,
      limit: () => self,
      then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => result().then(resolve, reject),
    }
    return self
  }
  // supabase.from(table) 的最小替身：房籍列、足跡清單、補評寫入
  const from = vi.fn((table: string) => ({
    select: () => chain(table === 'room_members' ? memberRows : history),
    update(patch: unknown, options: unknown) {
      ratingUpdate(patch, options)
      return chain(ratingWrite)
    },
  }))
  return { from, memberRows, history, ratingUpdate, ratingWrite }
})

vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from } }))
vi.mock('../lib/uid')
vi.mock('../lib/api')

// host_id 預設別人：房主移交敘述有自己的測試，其餘案例不受它干擾
const leaveRow = (id: string, code: string, status: Room['status'], hostId = 'someone-else') =>
  ({ room_id: id, rooms: { code, status, host_id: hostId } })
const rooms = (...rows: ReturnType<typeof leaveRow>[]) => mocks.memberRows.mockResolvedValue({ data: rows, error: null })

// data-key：每次導航都換新的 location key，看得出有沒有被導航第二次
function Home() {
  const { state, key } = useLocation()
  return <p data-key={key}>首頁{state ? ` ${JSON.stringify(state)}` : ''}</p>
}

const routes = () => (
  <MemoryRouter initialEntries={['/history']}>
    <Routes>
      <Route path="/history" element={<HistoryPage />} />
      <Route path="/" element={<Home />} />
    </Routes>
  </MemoryRouter>
)

async function renderHistory() {
  const view = render(routes())
  await settle()
  return view
}

const historyRow = (id: string, name: string, rating: number | null = null) =>
  ({ id, rating, decided_at: '2026-08-20T12:00:00Z', restaurants: { name, cuisine_tags: [] } })

const homeLink = () => screen.getByRole('link', { name: '回首頁' })
const dialog = () => screen.getByRole('dialog')

async function openLeave(link = homeLink()) {
  fireEvent.click(link)
  return screen.findByRole('dialog')
}

function expectNotice(text: string | null, ...args: Parameters<typeof leaveNotice>) {
  for (const line of leaveNotice(...args)) expect(text).toContain(line)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getUid).mockResolvedValue('me')
  vi.mocked(api.pendingLeave).mockReturnValue(null)
})

describe('足跡評分星形', () => {
  it('3 分仍渲染五顆星，前三顆實心、後兩顆空心', async () => {
    mocks.history.mockResolvedValue({ data: [{
      id: 'history-1', rating: 3, decided_at: '2026-08-20T12:00:00Z',
      restaurants: { name: '測試餐廳', cuisine_tags: [] },
    }], error: null, count: 1 })
    await renderHistory()
    const stars = [...screen.getByRole('img', { name: '已評 3 顆星' }).querySelectorAll('svg')]
    expect(stars.map(star => star.getAttribute('fill'))).toEqual(['currentColor', 'currentColor', 'currentColor', 'none', 'none'])
  })
})

describe('足跡清單', () => {
  // App 跑在 StrictMode 底下（main.tsx）：開發時 mount effect 跑兩次，兩輪載入同時在飛
  it('StrictMode 雙掛載：晚到的第一輪載入不得蓋掉後一輪的結果', async () => {
    const first = deferred<HistoryResult>()
    const second = deferred<HistoryResult>()
    mocks.history.mockReturnValueOnce(first.promise).mockReturnValueOnce(second.promise)
    render(<StrictMode>{routes()}</StrictMode>)
    await settle()
    expect(mocks.history).toHaveBeenCalledTimes(2)

    await act(async () => second.resolve({ data: [historyRow('h2', '新的那家')], error: null, count: 1 }))
    await settle()
    expect(screen.getByText('新的那家')).toBeTruthy()

    await act(async () => first.resolve({ data: [historyRow('h1', '舊的那家')], error: null, count: 1 }))
    await settle()
    expect(screen.queryByText('舊的那家')).toBeNull()
    expect(screen.getByText('新的那家')).toBeTruthy()
  })

  // 星排卸載後焦點會憑空消失（鍵盤／報讀中斷）：送出後焦點回到那一列（design review S8）
  it('補評送出後收合星排，下一幀焦點回到那一列', async () => {
    mocks.history.mockResolvedValue({ data: [historyRow('h1', '未評餐廳')], error: null, count: 1 })
    const frames = captureFrames()
    await renderHistory()
    fireEvent.click(screen.getByRole('button', { name: '尚未評分 · 補評' }))
    act(() => frames.flush()) // 展開側：焦點移進第一顆星
    expect(document.activeElement).toBe(screen.getByRole('button', { name: '1 顆星' }))

    fireEvent.click(screen.getByRole('button', { name: '4 顆星' }))
    fireEvent.click(screen.getByRole('button', { name: '送出評分' }))
    await settle()
    expect(mocks.ratingUpdate).toHaveBeenCalledWith({ rating: 4 }, { count: 'exact' })
    expect(screen.getByRole('img', { name: '已評 4 顆星' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: '送出評分' })).toBeNull()
    const row = screen.getByText('未評餐廳').closest('li')!
    expect(document.activeElement).not.toBe(row)
    act(() => frames.flush())
    expect(document.activeElement).toBe(row)
  })
})

describe('足跡頁回首頁離席確認', () => {
  // 沒有任何房籍快照可依賴：點擊當下一律先查（進頁時沒房、之後在別的分頁建房是
  // ADR-0007 自己承認的情境，快照放行就會靜默退掉那個新房）
  it('點回首頁一律先攔下來查，查到房就確認', async () => {
    rooms(leaveRow('room-1', 'ABC123', 'voting'))
    await renderHistory()
    const leave = await openLeave()
    expect(within(leave).getByRole('heading', { name: '回首頁會離開房間' })).toBeTruthy()
    expect(leave.textContent).toContain('你目前還在房間 ABC123 裡')
    expectNotice(leave.textContent, 'voting', 1, 'ABC123', false)
    expect(mocks.from).toHaveBeenCalledWith('room_members')
    expect(screen.queryByText(/^首頁/)).toBeNull()
  })

  // 文案只能來自點擊當下的查詢：本頁久留是預期用法，status／人數會在使用者眼前變
  it('用點擊當下查到的 status 與人數', async () => {
    const query = deferred<SelectResult>()
    mocks.memberRows.mockReturnValue(query.promise)
    await renderHistory()
    fireEvent.click(homeLink())
    expect(homeLink().getAttribute('aria-busy')).toBe('true')

    await act(async () => query.resolve({
      data: [leaveRow('room-1', 'ABC123', 'candidates'), leaveRow('room-1', 'ABC123', 'candidates')], error: null }))
    await settle()
    expectNotice(dialog().textContent, 'candidates', 2, 'ABC123', false)
    expect(dialog().textContent).not.toContain('你是房間裡唯一的人')
    expect(homeLink().getAttribute('aria-busy')).toBe('false')
  })

  it('查詢失敗改用保守文案，不假裝知道後果', async () => {
    mocks.memberRows.mockResolvedValue({ data: null, error: { message: 'boom' } })
    await renderHistory()
    const leave = await openLeave()
    expect(leave.textContent).toContain('房間現況查不到')
    expect(leave.textContent).not.toContain('可用邀請碼重新加入')
    expect(leave.textContent).not.toContain('會直接被刪除')
    expect(within(leave).queryByRole('link', { name: '回到房間' })).toBeNull() // 不知道回哪間
    expect(within(leave).getByRole('link', { name: '仍要回首頁' }).getAttribute('href')).toBe('/')
  })

  it('查到真的沒房可離：直接導航，不跳確認', async () => {
    rooms()
    await renderHistory()
    fireEvent.click(homeLink())
    expect(await screen.findByText('首頁')).toBeTruthy()
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  // 首頁末位退房還在飛（冷啟動）時點進足跡再回首頁：房還沒刪，當場查會誤問一間馬上
  // 消失的房（2026-10-10 回報）；等它落地則按鈕無聲卡住——交給首頁 mount 去等
  it('首頁的退房還在飛：不查房籍，直接回首頁', async () => {
    rooms(leaveRow('room-1', 'ABC123', 'pending'))
    vi.mocked(api.pendingLeave).mockReturnValue(new Promise<void>(() => {}))
    await renderHistory()
    fireEvent.click(homeLink())
    expect(await screen.findByText('首頁')).toBeTruthy()
    expect(mocks.from).not.toHaveBeenCalledWith('room_members')
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('空狀態的「回首頁開一場」同樣被攔', async () => {
    rooms(leaveRow('room-1', 'ABC123', 'voting'))
    await renderHistory()
    const leave = await openLeave(screen.getByRole('link', { name: '回首頁開一場' }))
    expect(leave.textContent).toContain('你目前還在房間 ABC123 裡')
    expect(screen.queryByText(/^首頁/)).toBeNull()
  })

  // PR #17 回歸：背景整塊帶著 inert，而 setLeaveDialog(null) 不同步 flush——同一輪呼叫
  // focus() 時觸發元素還在 inert 子樹內，瀏覽器直接忽略，焦點掉回 document.body。
  // 斷言的是「延後」這件事本身：關閉當下不得聚焦，要等 rAF 那一拍才還原。
  it('關閉後的焦點還原排到 rAF，不在還帶著 inert 的同一輪呼叫，並回到開框的那個入口', async () => {
    rooms(leaveRow('room-1', 'ABC123', 'voting'), leaveRow('room-1', 'ABC123', 'voting'))
    const frames = captureFrames()
    await renderHistory()
    let leave = await openLeave()
    expect(within(leave).getByRole('link', { name: '回到房間' }).getAttribute('href')).toBe('/room/room-1')
    expect(within(leave).getByRole('link', { name: '仍要回首頁' }).getAttribute('href')).toBe('/')
    const cancel = within(leave).getByRole('button', { name: '取消' })
    expect(document.activeElement).toBe(cancel) // autoFocus 落在取消

    fireEvent.click(cancel)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).not.toBe(homeLink()) // 這一輪背景還是 inert，現在聚焦只會被忽略
    expect(frames.pending).toBe(1)
    act(() => frames.flush())
    expect(document.activeElement).toBe(homeLink()) // 下一幀 inert 已移除，這次才真的聚焦得到

    // 另一個入口開的框按 Esc 關：焦點回到那個入口（兩個入口共用一個 dialog，觸發元素當場記下）
    const emptyStateLink = screen.getByRole('link', { name: '回首頁開一場' })
    leave = await openLeave(emptyStateLink)
    fireEvent.keyDown(within(leave).getByRole('button', { name: '取消' }), { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(document.activeElement).not.toBe(emptyStateLink)
    expect(frames.pending).toBe(1)
    act(() => frames.flush())
    expect(document.activeElement).toBe(emptyStateLink)
  })

  // fixed 遮罩擋得住指標，對 tab 順序毫無作用：沒有 inert，鍵盤可以 tab 到背景的
  // 「補評」chip 並按 Enter（Codex P2）
  it('dialog 開著時背景 inert，dialog 本身在 inert 子樹外', async () => {
    rooms(leaveRow('room-1', 'ABC123', 'voting'))
    await renderHistory()
    expect(homeLink().closest('[inert]')).toBeNull()

    const leave = await openLeave()
    // 整頁背景（標頭的回首頁連結與主內容）都在同一個 inert 子樹裡
    const background = homeLink().closest<HTMLElement>('[inert]')!
    expect(background).not.toBeNull()
    expect(background.contains(screen.getByRole('main'))).toBe(true)
    expect(background.contains(leave)).toBe(false)
    expect(within(background).getAllByRole('link').length).toBeGreaterThan(0) // 背景確實有可聚焦控制項
  })

  it('單房 dialog 文案沿用 leaveNotice（voting 兩人）', async () => {
    rooms(leaveRow('room-1', 'ABC123', 'voting'), leaveRow('room-1', 'ABC123', 'voting'))
    await renderHistory()
    const text = (await openLeave()).textContent
    expect(text).toContain('你目前還在房間 ABC123 裡')
    expect(text).toContain('你的投票會即刻作廢，候選盤面會重新計算')
    expect(text).toContain('你若是最後一位成員，房間會直接被刪除')
  })

  // P2-A：leave 是全退，兩個房籍都要講（舊房 leave 逾時後又建新房就會這樣）
  it('多房籍：兩個房的邀請碼與各自後果都列出，並各有回房入口', async () => {
    const decided = leaveRow('room-2', 'BBB222', 'decided', 'me')
    rooms(leaveRow('room-1', 'AAA111', 'lobby', 'me'), decided, decided, decided)
    await renderHistory()
    const leave = await openLeave()
    const text = leave.textContent!
    expect(text).toContain('你目前在 2 個房間裡，回首頁會一次全部離開')
    expect(text).toContain('房間 AAA111')
    expect(text).toContain('房間 BBB222')
    expect(text).toContain('邀請碼 AAA111 會跟著失效') // lobby 單人
    expect(text).toContain('抽中的結果之後只能在「足跡」查看') // decided 多人
    // 房主移交只講在有人可以繼任的那一間（AAA111 單人房是直接刪房）
    expect(text.split('房主身分會移交給').length - 1).toBe(1)
    expect(within(leave).getByRole('link', { name: '回到 AAA111' }).getAttribute('href')).toBe('/room/room-1')
    expect(within(leave).getByRole('link', { name: '回到 BBB222' }).getAttribute('href')).toBe('/room/room-2')
    // 不替使用者猜要回哪一間
    expect(within(leave).queryByRole('link', { name: '回到房間' })).toBeNull()
  })
})

describe('足跡頁房籍查詢', () => {
  // 多分頁：這個分頁進來時沒房，之後在別的分頁建了房——沒有快照可放行，一律當場查
  it('進頁時沒房、點擊時已在房間：照樣攔住並確認', async () => {
    rooms()
    await renderHistory()
    rooms(leaveRow('room-9', 'NEW999', 'lobby')) // 另一分頁建了房
    const leave = await openLeave()
    expect(leave.textContent).toContain('你目前還在房間 NEW999 裡')
    expect(screen.queryByText(/^首頁/)).toBeNull()
  })

  it('mount 不查房籍（沒有會過期的快照）', async () => {
    await renderHistory()
    expect(mocks.from).toHaveBeenCalledWith('dining_history')
    expect(mocks.from).not.toHaveBeenCalledWith('room_members')
  })

  it('多房籍：依 room_id 分組各自算人數', async () => {
    rooms(
      leaveRow('room-1', 'AAA111', 'lobby'),
      leaveRow('room-2', 'BBB222', 'decided'),
      leaveRow('room-2', 'BBB222', 'decided'),
    )
    await renderHistory()
    const text = (await openLeave()).textContent
    expectNotice(text, 'lobby', 1, 'AAA111', false) // 單人：房會直接刪
    expectNotice(text, 'decided', 2, 'BBB222', false) // 兩人：最後一位才刪
  })

  // 房主退出會移交（ADR-0007、leave.go）：host_id 要一起查回來跟自己的 uid 比對。
  // 兩人房才有移交可講（單人房是直接刪房）
  it('查回 host_id 比對 uid，房主房標成 isHost', async () => {
    const mine = leaveRow('room-1', 'AAA111', 'lobby', 'me')
    const theirs = leaveRow('room-2', 'BBB222', 'lobby')
    rooms(mine, mine, theirs, theirs)
    await renderHistory()
    const text = (await openLeave()).textContent!
    expect(text.split('你是房主：離開後房主身分會移交給其餘成員中最早加入的人').length - 1).toBe(1)
    expect(text).not.toContain('你若是房主')
  })

  // 拿不到 uid 就不知道自己是不是房主——不猜，交給 leaveNotice 用條件句
  it('取不到 uid 時不猜房主身分，改用條件句', async () => {
    vi.mocked(getUid).mockResolvedValue(null)
    const mine = leaveRow('room-1', 'AAA111', 'lobby', 'me')
    rooms(mine, mine)
    await renderHistory()
    const text = (await openLeave()).textContent
    expect(text).toContain('你若是房主，房主身分會移交給其餘成員中最早加入的人')
    expect(text).not.toContain('你是房主：')
  })

  it('getUid 拋錯只讓房主敘述退回條件句，不整份放棄成查不到', async () => {
    vi.mocked(getUid).mockRejectedValue(new Error('no session'))
    const mine = leaveRow('room-1', 'AAA111', 'lobby', 'me')
    rooms(mine, mine)
    await renderHistory()
    const text = (await openLeave()).textContent
    expect(text).toContain('你若是房主，房主身分會移交給其餘成員中最早加入的人')
    expect(text).not.toContain('房間現況查不到')
  })
})

// aria-busy 擋不住點擊：兩次點擊之間房籍會變（多分頁是 ADR-0007 承認的情境），
// 第一次的舊回應若晚到就會蓋掉第二次的結果
describe('足跡頁離席查詢的世代守衛', () => {
  it('晚到的舊「沒有房間」回應不得跳過剛開好的 dialog', async () => {
    const first = deferred<SelectResult>() // 第一次點擊時真的沒房
    mocks.memberRows.mockReturnValueOnce(first.promise)
      // 第二次點擊：另一個分頁剛加入房，這次的查詢先回來
      .mockResolvedValueOnce({ data: [leaveRow('room-9', 'NEW999', 'lobby')], error: null })
    await renderHistory()
    fireEvent.click(homeLink())
    fireEvent.click(homeLink())
    const leave = await screen.findByRole('dialog')
    expect(leave.textContent).toContain('NEW999')

    await act(async () => first.resolve({ data: [], error: null })) // 舊回應姍姍來遲
    await settle()
    expect(screen.queryByText(/^首頁/)).toBeNull() // 沒有繞過 dialog 直接退房
    expect(screen.getAllByRole('dialog')).toHaveLength(1)
    expect(homeLink().getAttribute('aria-busy')).toBe('false')
  })

  // 兩次點擊各開一次 busy，只有最後一次的回應負責關掉
  it('較早的點擊先回來也不算數：不導航、不收掉查詢中狀態，由最後一次點擊負責', async () => {
    const second = deferred<SelectResult>()
    mocks.memberRows.mockResolvedValueOnce({ data: [], error: null }).mockReturnValueOnce(second.promise)
    await renderHistory()
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

  it('首頁退房還在飛時的那一下也作廢較早還在查的點擊：舊回應不再導航第二次', async () => {
    const first = deferred<SelectResult>()
    mocks.memberRows.mockReturnValueOnce(first.promise)
    await renderHistory()
    fireEvent.click(homeLink()) // 查房籍中
    vi.mocked(api.pendingLeave).mockReturnValue(new Promise<void>(() => {}))
    fireEvent.click(homeLink()) // 這時首頁的退房在飛：直接回首頁
    const key = (await screen.findByText('首頁')).dataset.key

    await act(async () => first.resolve({ data: [], error: null })) // 第一下的「沒房」才回來
    await settle()
    expect(screen.getByText('首頁').dataset.key).toBe(key)
  })
})

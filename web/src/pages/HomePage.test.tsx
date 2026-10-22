// @vitest-environment jsdom
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes, useLocation, useNavigate, useNavigationType } from 'react-router-dom'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { leaveRooms, wakeApi } from '../lib/api'
import type { DeparturePoint } from '../lib/departure'
import { getPosition } from '../lib/geolocation'
import { leaveNotice } from '../lib/leaveNotice'
import { fetchLeaveRooms, type LeaveRoom } from '../lib/roomMembership'
import { getUid } from '../lib/uid'
import { deferred, settle } from '../test/dom'
import HomePage from './HomePage'

// 首頁是建房／加入的入口，也是「回首頁＝離席」（ADR-0007）的 mount 攔截點。
// 行為測試：真的 React hooks 跑在 jsdom 上，只在模組邊界 mock——lib/supabase（帳號、口味建議查詢、
// 建房／加入 RPC 與寫入）、lib/api（退房、後端預熱）、lib/roomMembership（房籍查詢本體由 HistoryPage.test.tsx
// 從頁面端整條打過，這裡只驗首頁的分支）、lib/uid、lib/geolocation（建房沒有上次出發點時抓目前位置），
// 以及包 Leaflet 的 LocationPicker。
// 斷言只看畫面（role／文字／屬性）、路由與送出去的呼叫參數，不看頁面內部有幾個 state。

type Result = { data?: unknown; error?: unknown; count?: number | null }
type AuthResult = { data: { user: { id: string; is_anonymous?: boolean } | null }; error: Error | null }

const mocks = vi.hoisted(() => {
  // 口味建議的三筆查詢與首頁評分卡各一個替身：測試可以單獨卡住或弄壞其中一筆
  const prefs = vi.fn(async (): Promise<Result> => ({ data: { default_prefs: { cuisines: [] } }, error: null }))
  const history = vi.fn(async (): Promise<Result> => ({ data: [], error: null }))
  const lowRows = vi.fn(async (): Promise<Result> => ({ data: [], error: null }))
  const recent = vi.fn(async (): Promise<Result> => ({ data: [], error: null }))
  const write = vi.fn(async (_table: string): Promise<Result> => ({ error: null, count: 1 }))
  const createRoom = vi.fn(async (_args: unknown): Promise<Result> => ({ data: 'room-1', error: null }))
  const joinRoom = vi.fn(async (_args: unknown): Promise<Result> => ({ data: 'room-2', error: null }))
  const rpcs: Record<string, (args: unknown) => Promise<Result>> = {
    get_my_default_prefs: () => prefs(), create_room: createRoom, join_room: joinRoom,
  }

  // 查詢鏈：後面可接任意 eq／is／gte／lte／order／limit，整條鏈被 await 時才依用過的條件取結果
  function chain(result: (ops: Set<string>) => Promise<Result>) {
    const ops = new Set<string>()
    let pending: Promise<Result> | undefined
    const self = {
      eq: () => self,
      is() {
        ops.add('is')
        return self
      },
      lte() {
        ops.add('lte')
        return self
      },
      gte: () => self,
      order: () => self,
      limit: () => self,
      then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
        pending ??= result(ops)
        return pending.then(resolve, reject)
      },
    }
    return self
  }
  // supabase.from(table) 的最小替身。dining_history 有三種讀法：口味建議的近 50 筆、
  // 低分列（lte）、首頁評分卡的最近一筆未評（is rating null）
  const from = vi.fn((table: string) => ({
    select: () => chain(ops => ops.has('is') ? recent() : ops.has('lte') ? lowRows() : history()),
    update: () => chain(() => write(table)),
  }))
  // rpc 的結果可以直接 await（create_room／join_room），也可以先接 .single()（get_my_default_prefs）
  const rpc = vi.fn((name: string, args?: unknown) => {
    let pending: Promise<Result> | undefined
    const self = {
      single: () => self,
      then(resolve: (r: Result) => unknown, reject?: (e: unknown) => unknown) {
        pending ??= rpcs[name](args)
        return pending.then(resolve, reject)
      },
    }
    return self
  })

  return {
    prefs, history, lowRows, recent, write, createRoom, joinRoom, from, rpc,
    getUser: vi.fn(async (): Promise<AuthResult> => ({ data: { user: { id: 'user-1', is_anonymous: false } }, error: null })),
    signOut: vi.fn(async () => ({ error: null })),
    picked: { lat: 25.0478, lng: 121.517, label: '台北車站' } as DeparturePoint,
  }
})

vi.mock('../lib/supabase', () => ({
  supabase: { from: mocks.from, rpc: mocks.rpc, auth: { getUser: mocks.getUser, signOut: mocks.signOut } },
}))
vi.mock('../lib/api')
vi.mock('../lib/uid')
vi.mock('../lib/roomMembership')
vi.mock('../lib/geolocation')
// 地圖（Leaflet）在 jsdom 跑不起來：換成目前出發點的地名，加一顆「選了這個點」的按鈕
vi.mock('../components/LocationPicker', async () => {
  const { createElement } = await import('react')
  return {
    default: ({ value, onChange }: { value: DeparturePoint | null; onChange: (p: DeparturePoint) => void }) =>
      createElement('div', null,
        createElement('p', null, `出發點：${value?.label ?? '未選'}`),
        createElement('button', { type: 'button', onClick: () => onChange(mocks.picked) }, '在地圖選這裡')),
  }
})

const ME = 'user-1'
const HERE = mocks.picked
const inRoom: LeaveRoom = { id: 'room-1', code: 'ABC123', status: 'lobby', memberCount: 2, isHost: false, stale: false }
const LOGOUT_WAIT = '正在確認房間狀態，確認後才能登出'

// 首頁這一筆 history entry 現在的 state 與導航方式：看得出旗標有沒有用 replace 當場消耗掉
function EntryProbe() {
  const { state } = useLocation()
  const how = useNavigationType()
  return <p hidden data-testid="entry" data-nav={how} data-state={JSON.stringify(state)} />
}

// 房間頁替身：「上一頁」就是瀏覽器返回，回到首頁那一筆 entry
function RoomStub() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  return (
    <>
      <p>房間頁 {pathname}</p>
      <button type="button" onClick={() => navigate(-1)}>上一頁</button>
    </>
  )
}

const routes = (state: unknown = null) => (
  <MemoryRouter initialEntries={[{ pathname: '/', state }]}>
    <Routes>
      <Route path="/" element={<><HomePage /><EntryProbe /></>} />
      <Route path="/room/:id" element={<RoomStub />} />
    </Routes>
  </MemoryRouter>
)

async function renderHome(state: unknown = null) {
  const view = render(routes(state))
  await settle()
  return view
}

const button = (name: string | RegExp) => screen.getByRole<HTMLButtonElement>('button', { name })
const queryButton = (name: string | RegExp) => screen.queryByRole<HTMLButtonElement>('button', { name })
const dialog = () => screen.getByRole('dialog')
const inDialog = (name: string) => within(dialog()).getByRole<HTMLButtonElement>('button', { name })
const card = (heading: string) => screen.getByRole('heading', { name: heading }).closest('section')!
const createCard = () => card('開一場聚餐決策')
const joinCard = () => card('已經有邀請碼？')
const entry = () => screen.getByTestId('entry').dataset
const onRoomPage = () => screen.queryByText(/^房間頁/)?.textContent ?? null
const createCalls = () => mocks.rpc.mock.calls.filter(([name]) => name === 'create_room')
const pickDeparture = () => fireEvent.click(button('在地圖選這裡'))

// 這台裝置記得的上次出發點：建房直接拿它當出發點，不必抓定位
function rememberDeparture(point: DeparturePoint, uid = ME) {
  localStorage.setItem(`last-departure:${uid}`, JSON.stringify(point))
}

// 瀏覽器封鎖網站資料時 localStorage 一碰就丟錯。只封鎖指定前綴的 key，其他讀寫照常
function blockStorage(prefix: string) {
  const readItem = Storage.prototype.getItem
  const writeItem = Storage.prototype.setItem
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(function (this: Storage, key: string) {
    if (key.startsWith(prefix)) throw new Error('storage blocked')
    return readItem.call(this, key)
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(function (this: Storage, key: string, value: string) {
    if (key.startsWith(prefix)) throw new Error('storage blocked')
    writeItem.call(this, key, value)
  })
}

function expectNotice(text: string | null, ...args: Parameters<typeof leaveNotice>) {
  for (const line of leaveNotice(...args)) expect(text).toContain(line)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getUid).mockResolvedValue(ME)
  vi.mocked(fetchLeaveRooms).mockResolvedValue([])
  vi.mocked(leaveRooms).mockResolvedValue(undefined)
  // jsdom 沒有 navigator.geolocation：預設抓不到定位，要定位成功的測試自己給座標
  vi.mocked(getPosition).mockRejectedValue(new Error('瀏覽器無法使用定位功能'))
})

describe('HomePage persistRoom', () => {
  it('以發起建房時的 uid 儲存出發點，不受 pending 期間換帳號影響', async () => {
    // create_room 還在飛的時候換了帳號：之後再讀 uid 拿到的是別人
    let uid = 'creator'
    vi.mocked(getUid).mockImplementation(async () => uid)
    vi.mocked(getPosition).mockResolvedValue({ lat: HERE.lat, lng: HERE.lng })
    mocks.createRoom.mockImplementation(async () => {
      uid = 'replacement'
      return { data: 'room-1', error: null }
    })
    await renderHome()
    fireEvent.click(button('建立房間'))
    await settle()

    const located = { lat: HERE.lat, lng: HERE.lng, label: '目前位置' }
    expect(createCalls()).toEqual([['create_room', { p_lat: 25.0478, p_lng: 121.517 }]])
    expect(onRoomPage()).toBe('房間頁 /room/room-1')
    expect(JSON.parse(localStorage.getItem('last-departure:creator')!)).toEqual(located)
    expect(localStorage.getItem('last-departure:replacement')).toBeNull()
    expect(JSON.parse(localStorage.getItem('room-departure:room-1')!)).toEqual(located)
  })

  it('發起時未登入便不建立房間', async () => {
    vi.mocked(getUid).mockResolvedValue(null)
    await renderHome()
    fireEvent.click(button('建立房間'))
    await settle()

    expect(getPosition).not.toHaveBeenCalled()
    expect(createCalls()).toEqual([])
    expect(localStorage.getItem('room-departure:room-1')).toBeNull()
    expect(onRoomPage()).toBeNull()
    expect(button('建立房間').disabled).toBe(false)
  })
})

// 首頁不選點、不選用餐時間（老師回饋：進房後都能改）：create_room 仍要座標，建房當下自己決定出發點
describe('HomePage 建房的出發點', () => {
  const LOCATE_FAILED = '抓不到目前位置，請選擇出發點'

  // mount 時還沒有紀錄、按下前才有：等同 loadSuggestions 的非同步還原還沒落地，點擊當下得自己補讀
  it('有上次出發點時直接建房，不呼叫 getPosition', async () => {
    await renderHome()
    rememberDeparture(HERE)
    fireEvent.click(button('建立房間'))
    await settle()

    expect(getPosition).not.toHaveBeenCalled()
    expect(createCalls()).toEqual([['create_room', { p_lat: 25.0478, p_lng: 121.517 }]])
    expect(JSON.parse(localStorage.getItem('room-departure:room-1')!)).toEqual(HERE)
    expect(onRoomPage()).toBe('房間頁 /room/room-1')
  })

  it('沒有上次出發點時用 getPosition 的座標建房，抓定位期間就顯示建立中', async () => {
    const located = deferred<{ lat: number; lng: number }>()
    vi.mocked(getPosition).mockReturnValue(located.promise)
    await renderHome()
    fireEvent.click(button('建立房間'))
    await settle()
    expect(button(/建立中/).disabled).toBe(true) // 定位最久 10 秒：沒有回饋會被當成沒反應而連按
    expect(createCalls()).toEqual([])

    await act(async () => located.resolve({ lat: 25.033, lng: 121.565 }))
    await settle()
    const here = { lat: 25.033, lng: 121.565, label: '目前位置' }
    expect(createCalls()).toEqual([['create_room', { p_lat: 25.033, p_lng: 121.565 }]])
    expect(JSON.parse(localStorage.getItem(`last-departure:${ME}`)!)).toEqual(here)
    expect(JSON.parse(localStorage.getItem('room-departure:room-1')!)).toEqual(here)
    expect(onRoomPage()).toBe('房間頁 /room/room-1')
  })

  it('getPosition 失敗時顯示選點、不呼叫 create_room；選好再按才建房', async () => {
    await renderHome()
    expect(screen.queryByText(/^出發點：/)).toBeNull() // 平常不顯示選點
    fireEvent.click(button('建立房間'))
    await settle()

    expect(getPosition).toHaveBeenCalledTimes(1)
    expect(createCalls()).toEqual([])
    expect(within(createCard()).getByText(LOCATE_FAILED).getAttribute('role')).toBe('status')
    expect(screen.getByText('出發點：未選')).toBeTruthy()
    expect(button('建立房間').disabled).toBe(true) // 選好出發點前不能再按

    pickDeparture()
    fireEvent.click(button('建立房間'))
    await settle()
    expect(getPosition).toHaveBeenCalledTimes(1) // 選好的點優先，不再抓定位
    expect(createCalls()).toEqual([['create_room', { p_lat: 25.0478, p_lng: 121.517 }]])
    expect(JSON.parse(localStorage.getItem('room-departure:room-1')!)).toEqual(HERE)
    expect(onRoomPage()).toBe('房間頁 /room/room-1')
  })

  // 權限詢問擱著時 getCurrentPosition 永遠不回：總時限一到就改開選點，busy 一起解除
  it('定位一直不回：10 秒後改開選點，建立與加入都解鎖', async () => {
    vi.mocked(getPosition).mockReturnValue(new Promise(() => {}))
    await renderHome()
    vi.useFakeTimers()
    fireEvent.click(button('建立房間'))
    await act(async () => { await vi.advanceTimersByTimeAsync(9_999) })
    expect(button(/建立中/).disabled).toBe(true)
    expect(button('加入').disabled).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(1) })
    expect(within(createCard()).getByText(LOCATE_FAILED)).toBeTruthy()
    expect(button('加入').disabled).toBe(false)
    expect(createCalls()).toEqual([])
  })

  it('等定位時離開首頁：定位晚到也不建房', async () => {
    const located = deferred<{ lat: number; lng: number }>()
    vi.mocked(getPosition).mockReturnValue(located.promise)
    const view = await renderHome()
    fireEvent.click(button('建立房間'))
    await settle()
    view.unmount()

    await act(async () => located.resolve({ lat: 25.033, lng: 121.565 }))
    await settle()
    expect(createCalls()).toEqual([])
    expect(localStorage.getItem(`last-departure:${ME}`)).toBeNull()
  })
})

describe('HomePage 錯誤就地顯示（QA ISSUE-003）', () => {
  it('建房錯誤渲染在建立房間的卡片內，不在頁尾', async () => {
    rememberDeparture(HERE)
    mocks.createRoom.mockResolvedValue({ data: null, error: { message: '建房失敗' } })
    await renderHome()
    fireEvent.click(button('建立房間'))
    await settle()
    expect(within(createCard()).getByRole('alert').textContent).toBe('建房失敗')
    expect(joinCard().textContent).not.toContain('建房失敗')
    expect(screen.getAllByRole('alert')).toHaveLength(1)
    expect(onRoomPage()).toBeNull()
  })
})

describe('HomePage guest 建房邊界', () => {
  const REGISTER = '註冊後建立房間'

  it('帳號狀態尚未確認時不顯示建房或註冊入口', async () => {
    mocks.getUser.mockReturnValue(new Promise(() => {}))
    await renderHome()
    expect(queryButton('建立房間')).toBeNull()
    expect(screen.queryByRole('link', { name: REGISTER })).toBeNull()
    expect(screen.getByText('正在確認帳號狀態…').getAttribute('role')).toBe('status')
  })

  it.each([
    ['尚未升級的匿名訪客', { id: 'guest-1', is_anonymous: true }, null, 'guest'],
    ['已寄驗證信但尚未完成升級的訪客', { id: 'guest-pending', is_anonymous: false }, 'guest@example.com', 'guest'],
    ['沒有升級標記的一般會員', { id: 'member-1', is_anonymous: false }, null, 'member'],
  ])('%s', async (_name, user, marker, expected) => {
    mocks.getUser.mockResolvedValue({ data: { user }, error: null })
    if (marker) localStorage.setItem(`guest-upgrade:${user.id}`, marker)
    await renderHome()
    const register = screen.queryByRole('link', { name: REGISTER })
    expect(register?.getAttribute('href') ?? null).toBe(expected === 'guest' ? '/auth?mode=register' : null)
    expect(queryButton('建立房間') !== null).toBe(expected === 'member')
  })

  it.each([
    ['getUser rejection', () => { mocks.getUser.mockRejectedValue(new Error('offline')) }],
    ['getUser error', () => { mocks.getUser.mockResolvedValue({ data: { user: null }, error: new Error('expired') }) }],
    ['getUser error with user', () => {
      mocks.getUser.mockResolvedValue({
        data: { user: { id: 'member-1', is_anonymous: false } }, error: new Error('unverified'),
      })
    }],
    ['missing user', () => { mocks.getUser.mockResolvedValue({ data: { user: null }, error: null }) }],
  ])('%s 時 fail closed 並可重試', async (_name, arrange) => {
    arrange()
    await renderHome()
    expect(queryButton('建立房間')).toBeNull()
    expect(screen.queryByRole('link', { name: REGISTER })).toBeNull()
    expect(screen.getByRole('alert').textContent).toContain('無法確認帳號狀態，請重新檢查')

    vi.restoreAllMocks()
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'member-1', is_anonymous: false } }, error: null })
    fireEvent.click(button('重新檢查'))
    await settle()
    expect(button('建立房間')).toBeTruthy()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('封鎖網站資料、讀不到升級標記時，會員照樣能建房', async () => {
    blockStorage('guest-upgrade:')
    rememberDeparture(HERE)
    await renderHome()
    fireEvent.click(button('建立房間'))
    await settle()
    expect(createCalls()).toHaveLength(1)
    expect(onRoomPage()).toBe('房間頁 /room/room-1')
  })

  it('封鎖網站資料時，匿名訪客仍只看到註冊入口', async () => {
    blockStorage('guest-upgrade:')
    mocks.getUser.mockResolvedValue({ data: { user: { id: 'guest-1', is_anonymous: true } }, error: null })
    await renderHome()
    expect(screen.getByRole('link', { name: REGISTER }).getAttribute('href')).toBe('/auth?mode=register')
    expect(queryButton('建立房間')).toBeNull()
  })
})

describe('HomePage 口味建議查詢失敗（Task 11）', () => {
  // 近 50 筆裡日式、韓式各吃過兩次，但低分列裡韓式被打過 1 星：完整資料只該建議日式。
  // 少了低分列就會連韓式一起建議——這組資料看得出有沒有拿缺一角的資料硬推
  const ate = (rating: number, tag: string) => ({ rating, restaurants: { cuisine_tags: [tag] } })
  const failed: Result = { data: null, error: new Error('query failed') }
  const okPrefs: Result = { data: { default_prefs: { cuisines: [] } }, error: null }
  const LOAD_ERROR = '口味建議暫時載入失敗；不影響建房與本次房內條件'
  const suggestion = () => screen.queryByText(/根據你的用餐紀錄/)?.textContent ?? null

  beforeEach(() => {
    mocks.history.mockResolvedValue({
      data: [ate(5, 'japanese'), ate(4, 'japanese'), ate(5, 'korean'), ate(4, 'korean')], error: null })
    mocks.lowRows.mockResolvedValue({ data: [ate(1, 'korean')], error: null })
    mocks.recent.mockResolvedValue({ data: [{ id: 'h1', rating: null, restaurants: { name: '拉麵店' } }], error: null })
  })

  // 首頁評分卡評完（StarRow 寫入成功 → onRated）會重新載入口味建議
  async function rateRecentMeal() {
    fireEvent.click(button('5 顆星'))
    fireEvent.click(button('送出評分'))
    await settle()
  }

  it('loads private preferences through the caller-bound RPC', async () => {
    await renderHome()
    expect(mocks.rpc).toHaveBeenCalledWith('get_my_default_prefs')
    expect(mocks.from).not.toHaveBeenCalledWith('profiles')
    expect(suggestion()).toContain('你常吃：日式。')
  })

  it.each([
    ['profile 單獨失敗', [0]],
    ['recent history 單獨失敗', [1]],
    ['low ratings 單獨失敗', [2]],
    ['任意兩筆失敗', [0, 1]],
    ['三筆全部失敗', [0, 1, 2]],
  ])('%s：清掉舊建議、顯示非阻擋訊息，且不以缺資料推論', async (_name, broken) => {
    await renderHome()
    expect(suggestion()).toContain('你常吃：日式。') // 上一輪留下的建議

    const queries = [mocks.prefs, mocks.history, mocks.lowRows]
    for (const i of broken) queries[i].mockResolvedValueOnce(failed)
    await rateRecentMeal()
    expect(mocks.write).toHaveBeenCalledWith('dining_history') // 評分確實寫出去才觸發重新載入
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy()
    expect(suggestion()).toBeNull()
  })

  it('任一查詢失敗仍先還原上次出發點，照樣拿它建房', async () => {
    rememberDeparture({ lat: 25.033, lng: 121.565, label: '上次的出發點' })
    rememberDeparture({ lat: 24.1, lng: 120.6, label: '別人的出發點' }, 'someone-else')
    mocks.prefs.mockResolvedValueOnce(failed)
    await renderHome()
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy()

    fireEvent.click(button('建立房間'))
    await settle()
    expect(getPosition).not.toHaveBeenCalled()
    expect(createCalls()).toEqual([['create_room', { p_lat: 25.033, p_lng: 121.565 }]])
  })

  it('失敗訊息不阻擋建房或加入，並以 status 呈現 exact copy', async () => {
    rememberDeparture(HERE)
    mocks.history.mockResolvedValueOnce(failed)
    await renderHome()
    expect(screen.getByText(LOAD_ERROR).closest('[role="status"]')).not.toBeNull()
    expect(button('建立房間').disabled).toBe(false)
    expect(button('加入').disabled).toBe(false)
  })

  it('後續成功 reload 完成前保留舊訊息，完成後才清除並正常產生建議', async () => {
    mocks.history.mockResolvedValueOnce(failed)
    await renderHome()
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy()

    const gate = deferred<Result>()
    mocks.prefs.mockReturnValueOnce(gate.promise)
    await rateRecentMeal()
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy() // 還在查：舊訊息不提早收掉
    expect(suggestion()).toBeNull()

    await act(async () => gate.resolve(okPrefs))
    await settle()
    expect(screen.queryByText(LOAD_ERROR)).toBeNull()
    expect(suggestion()).toContain('你常吃：日式。')
  })

  it('較舊 failure 晚到時不覆蓋較新 success', async () => {
    const old = deferred<Result>()
    mocks.prefs.mockReturnValueOnce(old.promise)
    await renderHome()
    await rateRecentMeal()
    expect(suggestion()).toContain('你常吃：日式。')

    await act(async () => old.resolve(failed))
    await settle()
    expect(screen.queryByText(LOAD_ERROR)).toBeNull()
    expect(suggestion()).toContain('你常吃：日式。')
  })

  it('較舊 success 晚到時不清除較新 failure', async () => {
    const old = deferred<Result>()
    mocks.prefs.mockReturnValueOnce(old.promise)
    await renderHome()
    mocks.lowRows.mockResolvedValueOnce(failed)
    await rateRecentMeal()
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy()

    await act(async () => old.resolve(okPrefs))
    await settle()
    expect(screen.getByText(LOAD_ERROR)).toBeTruthy()
    expect(suggestion()).toBeNull()
  })

  // 離開首頁後才回來的結果：React 19 對已卸載元件的 setState 靜默丟掉，畫面上看不出差別，
  // 看得到的只有卸載後還有沒有往外做事（發查詢、讀這台裝置的忽略清單）
  it('unmount 後 uid 才回來：不再發出口味查詢', async () => {
    const uid = deferred<string | null>()
    vi.mocked(getUid).mockReturnValue(uid.promise)
    const view = await renderHome()
    view.unmount()

    await act(async () => uid.resolve(ME))
    await settle()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('unmount 後查詢才回來：不再往下推論建議', async () => {
    const gate = deferred<Result>()
    mocks.prefs.mockReturnValueOnce(gate.promise)
    const view = await renderHome()
    view.unmount()

    const read = vi.spyOn(Storage.prototype, 'getItem')
    await act(async () => gate.resolve(okPrefs))
    await settle()
    expect(read).not.toHaveBeenCalledWith(`prefs-suggest-dismissed:${ME}`)
  })

  // 評分卡的寫入還在飛就離開首頁：寫入成功後 onRated 才回呼，這時頁面已經不在，不該再查一輪建議
  it('評分寫入途中離開首頁：寫入成功後不再重新載入口味建議', async () => {
    const write = deferred<Result>()
    mocks.write.mockReturnValueOnce(write.promise)
    const view = await renderHome()
    fireEvent.click(button('5 顆星'))
    fireEvent.click(button('送出評分'))
    await settle()
    const loads = mocks.prefs.mock.calls.length
    view.unmount()

    await act(async () => write.resolve({ error: null, count: 1 }))
    await settle()
    expect(mocks.write).toHaveBeenCalledWith('dining_history')
    expect(mocks.prefs).toHaveBeenCalledTimes(loads)
  })

  it('按忽略會記在這台裝置，之後重新載入不再建議同一菜系', async () => {
    localStorage.setItem(`prefs-suggest-dismissed:${ME}`, 'korean')
    await renderHome()
    fireEvent.click(button('忽略'))
    expect(suggestion()).toBeNull()
    expect(localStorage.getItem(`prefs-suggest-dismissed:${ME}`)).toBe('korean,japanese')

    const loads = mocks.prefs.mock.calls.length
    await rateRecentMeal()
    expect(mocks.prefs.mock.calls.length).toBeGreaterThan(loads) // 確實重新載入過
    expect(suggestion()).toBeNull()
  })

  it('忽略清單讀寫都丟錯：建議照常顯示，按忽略照樣收起', async () => {
    blockStorage('prefs-suggest-dismissed:')
    await renderHome()
    expect(suggestion()).toContain('你常吃：日式。')
    expect(screen.queryByText(LOAD_ERROR)).toBeNull()

    fireEvent.click(button('忽略'))
    expect(suggestion()).toBeNull()
  })
})

describe('HomePage 評分卡的略過', () => {
  const ratingCard = () => screen.queryByText(/滿意嗎/)?.textContent ?? null

  beforeEach(() => {
    mocks.recent.mockResolvedValue({ data: [{ id: 'h1', rating: null, restaurants: { name: '拉麵店' } }], error: null })
  })

  it('略過記在這台裝置：同一筆之後不再出現', async () => {
    localStorage.setItem(`rating-dismissed:${ME}`, 'h0')
    const view = await renderHome()
    expect(ratingCard()).toBe('上次吃的《拉麵店》滿意嗎？')
    fireEvent.click(button('略過'))
    expect(ratingCard()).toBeNull()
    expect(localStorage.getItem(`rating-dismissed:${ME}`)).toBe('h0,h1')

    view.unmount()
    await renderHome()
    expect(mocks.recent).toHaveBeenCalledTimes(2) // 確實又查了一次
    expect(ratingCard()).toBeNull()
  })

  it('略過清單讀寫都丟錯：評分卡照常出現，按略過照樣收起', async () => {
    blockStorage('rating-dismissed:')
    await renderHome()
    expect(ratingCard()).toBe('上次吃的《拉麵店》滿意嗎？')

    fireEvent.click(button('略過'))
    expect(ratingCard()).toBeNull()
  })
})

describe('HomePage 邀請碼 native validation', () => {
  it('輸入使用原生十二碼 hex 約束，編輯時同步清除舊錯誤', async () => {
    mocks.joinRoom.mockResolvedValue({ data: null, error: { message: 'not found' } })
    await renderHome()
    const input = screen.getByRole<HTMLInputElement>('textbox', { name: '邀請碼' })
    expect(input.required).toBe(true)
    expect(input.minLength).toBe(12)
    expect(input.maxLength).toBe(12)
    expect(input.pattern).toBe('[0-9A-Fa-f]{12}')

    fireEvent.change(input, { target: { value: 'A1B2C3D4E5F6' } })
    fireEvent.click(button('加入'))
    await settle()
    expect(mocks.rpc).toHaveBeenCalledWith('join_room', { p_code: 'A1B2C3D4E5F6' })
    expect(within(joinCard()).getByRole('alert').textContent).toBe('房間不存在或已開始')

    fireEvent.change(input, { target: { value: 'A1B2C3D4E5F7' } })
    expect(input.value).toBe('A1B2C3D4E5F7')
    expect(screen.queryByRole('alert')).toBeNull()
  })
})

describe('HomePage 退房閘門', () => {
  it('leave 未 settle 前建立房間與加入都禁用', async () => {
    vi.mocked(fetchLeaveRooms).mockReturnValue(new Promise(() => {}))
    await renderHome()
    expect(button('建立房間').disabled).toBe(true)
    expect(button('加入').disabled).toBe(true)
  })

  it('leave settle 後兩鈕解禁', async () => {
    await renderHome()
    expect(button('建立房間').disabled).toBe(false)
    expect(button('加入').disabled).toBe(false)
  })
})

// 登出沒有閘門就是幽靈成員的來源：查房籍還在飛、或確認 dialog 開著時登出，App.tsx 的
// auth listener 會卸載 HomePage，doLeave() 永遠不會執行，伺服器端房籍留著——那個人的
// 條件與票繼續約束房間盤面。原本 mount 是無條件立刻送 leaveRooms()，窗口只有毫秒級；
// 改成「先查再問」之後窗口被拉長到「等一個人做決定」。
describe('HomePage 登出閘門', () => {
  it('查房籍未 settle 前登出禁用並就地說明原因', async () => {
    vi.mocked(fetchLeaveRooms).mockReturnValue(new Promise(() => {}))
    await renderHome()
    expect(button('登出').disabled).toBe(true)
    expect(screen.getByText(LOGOUT_WAIT).getAttribute('role')).toBe('status')
  })

  it('離席確認 dialog 開著時登出仍禁用（使用者還沒決定要不要退房）', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue([inRoom])
    await renderHome()
    expect(dialog()).toBeTruthy()
    expect(button('登出').disabled).toBe(true)
  })

  it('leave settle 後登出解禁', async () => {
    await renderHome()
    expect(screen.queryByText(LOGOUT_WAIT)).toBeNull()
    expect(button('登出').disabled).toBe(false)
    fireEvent.click(button('登出'))
    expect(mocks.signOut).toHaveBeenCalledTimes(1)
  })

  // 這條是本輪最容易被弄壞的地方：把登出掛上 leavePending 之後，任何讓 leavePending
  // 永遠停在 true 的路徑都會把使用者鎖死在首頁（比幽靈房籍更糟）。懸掛的連線就是那條
  // 路徑——fetchLeaveRooms 的 5 秒逾時把它併進「查詢失敗」（roomMembership.test.ts
  // 釘住逾時本身），這裡把逾時之後的後半段走完：dialog 一定出得來，按下去一定解禁。
  it('查詢逾時（回 null）：保守 dialog 出得來，按離開房間後登出鍵回到可用', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue(null) // 逾時與查詢失敗同一條路徑
    await renderHome()
    expect(dialog().textContent).toContain('房間現況查不到')
    expect(button('登出').disabled).toBe(true) // 決定前仍鎖著

    fireEvent.click(inDialog('離開房間'))
    await settle()
    expect(leaveRooms).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button('登出').disabled).toBe(false) // 沒有永久禁用這條路
  })
})

// ADR-0007（2026-08-16 修訂）：mount 是所有繞過路徑的咽喉，但不再靜默退房
describe('HomePage mount 離席確認', () => {
  it('查到房間不自動退房，改開離席確認', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue([inRoom])
    await renderHome()
    expect(screen.getByRole('dialog', { name: '你還在房間裡' })).toBeTruthy()
    expect(leaveRooms).not.toHaveBeenCalled()
    // 閘門不得在使用者決定前解除
    expect(screen.getByText(LOGOUT_WAIT)).toBeTruthy()
    expect(button('加入').disabled).toBe(true)
  })

  // room_members 就是權威（RLS 只回自己的列）：回空代表真的沒房可退，不必打 /api/leave
  it('查到沒有房間：不退房，直接解除 leavePending', async () => {
    await renderHome()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(leaveRooms).not.toHaveBeenCalled()
    expect(screen.queryByText(LOGOUT_WAIT)).toBeNull()
    expect(button('加入').disabled).toBe(false)
  })

  // 殘留房（ADR-0007 2026-10-01 修訂）：滑掉 App 或退房請求失敗留下的過期房，隔幾天不再問要不要回房
  it('全是殘留房就直接退房，不開 dialog', async () => {
    const leave = deferred<void>()
    vi.mocked(leaveRooms).mockReturnValue(leave.promise)
    vi.mocked(fetchLeaveRooms).mockResolvedValue([{ ...inRoom, stale: true }])
    await renderHome()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(leaveRooms).toHaveBeenCalledTimes(1)
    expect(button('加入').disabled).toBe(true) // 退房還在飛：閘門照舊

    await act(async () => leave.resolve())
    await settle()
    expect(button('加入').disabled).toBe(false)
  })

  it('殘留房混著進行中的房仍整份問：/api/leave 全退不挑房', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue([{ ...inRoom, stale: true }, { ...inRoom, id: 'room-2', code: 'DEF456' }])
    await renderHome()
    const text = dialog().textContent
    expect(text).toContain('你還在 2 個房間裡')
    expect(text).toContain('房間 ABC123')
    expect(text).toContain('房間 DEF456')
    expect(leaveRooms).not.toHaveBeenCalled()
  })

  // 退房不可逆：查不到現況就不准替使用者按下去
  it('房籍查詢失敗不靜默退房，改開保守 dialog', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue(null)
    await renderHome()
    expect(dialog().textContent).toContain('房間現況查不到')
    expect(leaveRooms).not.toHaveBeenCalled()
    expect(button('加入').disabled).toBe(true)
  })

  // RoomPage／HistoryPage 的離席確認已經把同一份後果講完了，首頁再問一次＝連跳兩張。
  // 但旗標掛在 history entry 上（重整與上一頁都會還原），用完必須當場 replace 掉。
  it('房內已確認過（帶 leaveConfirmed）就直接退房，不再查也不再問，並當場消耗旗標', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue([inRoom])
    await renderHome({ leaveConfirmed: true })
    expect(leaveRooms).toHaveBeenCalledTimes(1)
    expect(entry().nav).toBe('REPLACE') // 蓋掉同一筆 entry，不是多推一筆
    expect(entry().state).toBe('null') // entry 上已經沒有旗標
    expect(fetchLeaveRooms).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button('加入').disabled).toBe(false)
  })

  // 這條是本輪 review 的核心：旗標若沒被消耗，「退房 → 在首頁建新房 → 上一頁」
  // 會讀回同一筆 entry 的旗標，直接靜默退掉新房——正是 mount 攔截要防的那個繞過
  it('旗標消耗後回到同一筆 entry：不再直接退房，改走查房籍→開 dialog', async () => {
    rememberDeparture(HERE)
    await renderHome({ leaveConfirmed: true }) // 房內確認過的那一次：直接退房並消耗旗標
    expect(leaveRooms).toHaveBeenCalledTimes(1)
    fireEvent.click(button('建立房間'))
    await settle()
    expect(onRoomPage()).toBe('房間頁 /room/room-1')

    vi.mocked(fetchLeaveRooms).mockResolvedValue([inRoom])
    fireEvent.click(button('上一頁')) // 回到同一筆 entry
    await settle()
    expect(entry().nav).toBe('POP')
    expect(fetchLeaveRooms).toHaveBeenCalledTimes(1)
    expect(dialog().textContent).toContain('你還在房間 ABC123 裡')
    expect(leaveRooms).toHaveBeenCalledTimes(1) // 新建的房沒有被靜默退掉
  })

  // 消耗旗標的 replace 會讓 location 換新物件、effect 相依變動而重跑；此時 state 已是 null，
  // 沒有「每次 mount 只決策一次」的守衛就會掉進查房籍那條路，在 doLeave() 還在飛的時候開一張 dialog。
  // App 又跑在 StrictMode 底下（main.tsx）：開發時 mount effect 本來就跑兩次，同一道守衛也擋住重複退房。
  it('消耗旗標造成的 effect 重跑不會再走查房籍那條路（StrictMode 雙跑也只退一次）', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue([inRoom])
    render(<StrictMode>{routes({ leaveConfirmed: true })}</StrictMode>)
    await settle()
    expect(entry().state).toBe('null') // 旗標已消耗，effect 已隨 location 重跑
    expect(leaveRooms).toHaveBeenCalledTimes(1)
    expect(fetchLeaveRooms).not.toHaveBeenCalled()
    expect(screen.queryByRole('dialog')).toBeNull()
  })
})

describe('HomePage 離席確認 dialog', () => {
  beforeEach(() => { vi.mocked(fetchLeaveRooms).mockResolvedValue([inRoom]) })

  // 使用者還沒決定要不要退房，此時建房正是那個競態（晚到的全退會誤刪新房）
  it('dialog 開著時建房與加入維持禁用', async () => {
    await renderHome()
    expect(dialog()).toBeTruthy()
    expect(button('建立房間').disabled).toBe(true)
    expect(button('加入').disabled).toBe(true)
  })

  it('確認離開才呼叫 leaveRooms，settle 後解除閘門', async () => {
    const leave = deferred<void>()
    vi.mocked(leaveRooms).mockReturnValue(leave.promise)
    await renderHome()
    const text = dialog().textContent
    expect(text).toContain('你還在房間 ABC123 裡')
    expect(text).toContain('你若是最後一位成員，房間會直接被刪除')
    expectNotice(text, 'lobby', 2, 'ABC123', false)

    fireEvent.click(inDialog('離開房間'))
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(leaveRooms).toHaveBeenCalledTimes(1)
    expect(button('加入').disabled).toBe(true) // 退房還在飛

    await act(async () => leave.resolve())
    await settle()
    expect(button('加入').disabled).toBe(false)
    expect(onRoomPage()).toBeNull() // 留在首頁
  })

  it('首頁 best-effort 離席失敗仍解除閘門，不產生未處理 rejection', async () => {
    vi.mocked(leaveRooms).mockRejectedValue(new Error('offline'))
    await renderHome()
    fireEvent.click(inDialog('離開房間'))
    await settle()
    expect(leaveRooms).toHaveBeenCalledTimes(1)
    expect(button('加入').disabled).toBe(false)
    expect(button('登出').disabled).toBe(false)
  })

  it('取消（回到房間）導回房間且不退房', async () => {
    await renderHome()
    // 焦點落在安全的那顆：Enter 一按不會就退房
    expect(document.activeElement).toBe(inDialog('回到房間'))
    fireEvent.click(inDialog('回到房間'))
    expect(onRoomPage()).toBe('房間頁 /room/room-1')
    expect(leaveRooms).not.toHaveBeenCalled()
  })

  // leave 是全退（POST /api/leave 不挑房），每個房籍都要講、都要有回房入口
  it('多房籍：各房後果分別列出，各給一個回房入口', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue([
      { id: 'room-1', code: 'AAA111', status: 'lobby', memberCount: 1, isHost: true, stale: false },
      { id: 'room-2', code: 'BBB222', status: 'decided', memberCount: 3, isHost: true, stale: false },
    ])
    await renderHome()
    const text = dialog().textContent
    expect(text).toContain('你還在 2 個房間裡')
    expect(text).toContain('邀請碼 AAA111 會跟著失效') // lobby 單人
    expect(text).toContain('抽中的結果之後只能在「足跡」查看') // decided 多人
    expect(within(dialog()).queryByRole('button', { name: '回到房間' })).toBeNull() // 不替使用者猜要回哪一間
    expect(document.activeElement).toBe(inDialog('回到 AAA111'))

    fireEvent.click(inDialog('回到 BBB222'))
    expect(onRoomPage()).toBe('房間頁 /room/room-2')
  })

  it('查詢失敗的保守 dialog：不講具體後果，也不給猜的回房入口', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValue(null)
    await renderHome()
    const text = dialog().textContent
    expect(text).toContain('房間現況查不到')
    expect(text).not.toContain('可用邀請碼重新加入')
    expect(text).not.toContain('會直接被刪除')
    expect(within(dialog()).queryByRole('button', { name: '回到房間' })).toBeNull()
    // 不確定就先重新整理：焦點落在這顆，不是離開房間
    expect(document.activeElement).toBe(inDialog('重新整理再試'))
    expect(inDialog('離開房間')).toBeTruthy()
  })

  // fixed 遮罩擋得住指標，對 tab 順序毫無作用：沒有 inert，鍵盤可以 tab 到背景的
  // 「建立房間」按 Enter，繞過還沒決定的退房
  it('dialog 開著時背景 inert，dialog 本身在 inert 子樹外', async () => {
    const rooms = deferred<LeaveRoom[] | null>()
    vi.mocked(fetchLeaveRooms).mockReturnValue(rooms.promise)
    await renderHome()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(button('建立房間').closest('[inert]')).toBeNull()

    await act(async () => rooms.resolve([inRoom]))
    await settle()
    // 背景真的含著會被鍵盤觸發的控制項（建立房間）與整個主內容
    const background = button('建立房間').closest<HTMLElement>('[inert]')
    expect(background).not.toBeNull()
    expect(background!.contains(screen.getByRole('main'))).toBe(true)
    expect(background!.contains(dialog())).toBe(false)
  })
})

// 已登入的人不經過 AuthPage：首頁是第一個能喚醒 Render 的地方，第一支打到 Render 的請求就是「開始搜尋」
describe('HomePage 後端預熱', () => {
  it('mount 時 GET /healthz；卸載（建房後換到房間頁）不取消預熱', async () => {
    const actual = await vi.importActual<typeof import('../lib/api')>('../lib/api')
    vi.mocked(wakeApi).mockImplementation(actual.wakeApi)
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    vi.stubEnv('VITE_API_URL', '')
    onTestFinished(() => {
      vi.unstubAllGlobals()
      vi.unstubAllEnvs()
    })

    const view = await renderHome()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('/healthz', expect.objectContaining({ method: 'GET' }))
    const init = fetchMock.mock.calls[0][1]
    view.unmount()
    expect(init?.signal?.aborted ?? false).toBe(false)
  })
})

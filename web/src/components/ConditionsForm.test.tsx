// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { DIETARY_OPTIONS } from '../lib/labels'
import type { MemberRow } from '../lib/types'
import { deferred } from '../test/dom'
import ConditionsForm from './ConditionsForm'

// 行為測試：真的 React hooks 跑在 jsdom 上，只 mock lib/supabase（條件批次寫入與 set_member_ready RPC）。
// 斷言只看畫面（slider 值、aria-pressed、disabled、role=alert）與送出去的寫入參數；
// 「最後一次 durable 的值」看不到，就讓下一筆寫入失敗，看畫面還原成哪個值。

type WriteResult = { error: { message: string } | null; count: number | null }
type Props = Parameters<typeof ConditionsForm>[0]

const mocks = vi.hoisted(() => ({
  from: vi.fn(),
  rpc: vi.fn(),
  update: vi.fn(),
  eqRoom: vi.fn(),
  eqUser: vi.fn(),
}))

vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from, rpc: mocks.rpc } }))

const me: MemberRow = {
  room_id: 'room-1', user_id: 'user-b', budget_max: 800, cuisines: [], dietary: [],
  max_distance_m: 1000, transport: 'walking', ready: false,
}

const CONDITION_ERROR = '儲存失敗：房間可能已開始選餐，條件已凍結'
const READY_ERROR = '準備狀態更新失敗：請確認最新地點與房間狀態後再試'
const FAILED: WriteResult = { error: { message: 'boom' }, count: null }

beforeEach(() => {
  mocks.eqUser.mockReset().mockResolvedValue({ error: null, count: 1 })
  mocks.eqRoom.mockReset().mockReturnValue({ eq: mocks.eqUser })
  mocks.update.mockReset().mockReturnValue({ eq: mocks.eqRoom })
  mocks.from.mockReset().mockReturnValue({ update: mocks.update })
  mocks.rpc.mockReset().mockResolvedValue({ data: true, error: null })
})

const form = (props: Partial<Props> = {}) => <ConditionsForm me={me} isHost={false} searchVersion={7} {...props} />
const budget = () => screen.getByRole<HTMLInputElement>('slider', { name: /價位偏好/ })
const button = (name: string) => screen.getByRole<HTMLButtonElement>('button', { name })
const pressed = (el: HTMLElement) => el.getAttribute('aria-pressed')
const alertText = () => screen.queryByRole('alert')?.textContent ?? null
const controls = () => [
  ...screen.getAllByRole<HTMLButtonElement>('button'),
  ...screen.getAllByRole<HTMLInputElement>('slider'),
]
// 拖價位 slider：每格都觸發 onChange，元件自己 debounce 400ms 才寫
const drag = (value: number) => fireEvent.change(budget(), { target: { value: String(value) } })

// 讓 mock 的 promise（寫入、RPC）在 act 裡落地；不推進時間
async function settle() {
  await act(() => vi.advanceTimersByTimeAsync(0))
}

async function debounce() {
  await act(() => vi.advanceTimersByTimeAsync(401))
  await settle()
}

// RoomPage 開始搜尋前會呼叫元件交出來的 flushPending，確認條件都 durable 了才送
function renderWithFlush(props: Partial<Props> = {}) {
  let registered: (() => Promise<boolean>) | null = null
  const view = render(form({ ...props, onFlushAvailable: fn => { registered = fn } }))
  async function flush() {
    const fn: (() => Promise<boolean>) | null = registered
    if (!fn) throw new Error('ConditionsForm 未註冊 flushPending')
    let ok: boolean | undefined
    await act(async () => { ok = await fn() })
    return ok
  }
  return { view, flush }
}

describe('ConditionsForm 條件寫入防線', () => {
  beforeEach(() => { vi.useFakeTimers() })

  it('成員編輯後立刻按 Ready，條件 PATCH 成功前不會送 ready PATCH', async () => {
    const condition = deferred<WriteResult>()
    mocks.eqUser.mockReturnValueOnce(condition.promise)
    render(form())

    drag(900)
    fireEvent.click(button('我準備好了'))
    await settle()
    expect(mocks.update).toHaveBeenCalledTimes(1)
    expect(mocks.update.mock.calls[0][0]).toMatchObject({ budget_max: 900 })
    expect(mocks.rpc).not.toHaveBeenCalled()

    await act(async () => condition.resolve({ error: null, count: 1 }))
    await settle()
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_ready', {
      p_room_id: 'room-1', p_ready: true, p_search_version: 7,
    })
    expect(pressed(button('已準備（點擊取消）'))).toBe('true')
  })

  it('價位偏好保留原生 slider 與質性說明', () => {
    const { container } = render(form())
    const slider = budget()
    const copy = container.textContent

    expect(slider.type).toBe('range')
    expect([slider.min, slider.max, slider.step]).toEqual(['100', '1600', '100'])
    expect(copy).toContain('價位偏好')
    expect(copy).toContain('偏高')
    expect(copy).toContain('偏好刻度 800')
    expect(copy).toContain('Google 提供粗略價位層級')
    expect(copy).not.toContain('每人預算上限')
    expect(copy).not.toContain('NT$')
  })

  it('飲食禁忌只提供有正向證據的素食選項', () => {
    const { container } = render(form())
    const dietary = within(screen.getByRole('group', { name: '飲食禁忌' })).getAllByRole('button')
    const copy = container.textContent

    expect(DIETARY_OPTIONS).toEqual([['vegetarian', '素食']])
    expect(dietary.map(b => b.textContent)).toEqual(['素食'])
    expect(copy).not.toContain('不吃牛')
    expect(copy).not.toContain('不吃豬')
  })

  it('legacy 無效價位偏好不誤顯示有效層級，仍可改回合法 slider 值', async () => {
    const { container } = render(form({ me: { ...me, budget_max: 50 } }))
    const copy = container.textContent

    expect(copy).toContain('未設定')
    expect(copy).not.toContain('平價')
    expect(copy).not.toContain('免費')
    expect(copy).not.toContain('NT$')
    expect(budget().disabled).toBe(false)

    drag(100)
    await debounce()
    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({ budget_max: 100 }), { count: 'exact' })
  })

  it('legacy 超過 slider 上限的價位偏好也顯示未設定', () => {
    const { container } = render(form({ me: { ...me, budget_max: 1700 } }))
    expect(container.textContent).toContain('未設定')
    expect(container.textContent).not.toContain('高價')
  })

  it.each([
    ['PATCH 回錯誤', () => mocks.eqUser.mockResolvedValueOnce(FAILED)],
    // RLS 凍結時 UPDATE 影響 0 列、回 204 無 error：只看 error 會誤判成功
    ['RLS 擋下（無 error、0 列）', () => mocks.eqUser.mockResolvedValueOnce({ error: null, count: 0 })],
    ['網路斷線', () => mocks.eqUser.mockRejectedValueOnce(new Error('offline'))],
  ])('最新條件寫入失敗（%s）會回到最後 durable snapshot 並呈現 role=alert', async (_, fail) => {
    fail()
    render(form())

    drag(900)
    expect(screen.getByText('偏好刻度 900')).toBeTruthy()
    await debounce()
    expect(alertText()).toBe(CONDITION_ERROR)
    expect(budget().value).toBe('800')
    expect(screen.getByText('偏好刻度 800')).toBeTruthy()
  })

  it('舊 generation 失敗不得回滾更新一代仍在畫面上的編輯', async () => {
    const oldWrite = deferred<WriteResult>()
    mocks.eqUser.mockReturnValueOnce(oldWrite.promise)
    const { flush } = renderWithFlush()

    drag(900)
    await debounce()
    drag(1000)
    await act(async () => oldWrite.resolve({ error: { message: 'old failed' }, count: 0 }))
    await settle()
    // 舊的失敗只立 error gate，畫面上較新的 1000 不能被抹掉
    expect(alertText()).toBe(CONDITION_ERROR)
    expect(budget().value).toBe('1000')

    await debounce()
    expect(await flush()).toBe(true)
    expect(alertText()).toBeNull()
  })

  it('條件寫入依 generation 序列化，舊 success 不會蓋掉較新的 durable snapshot', async () => {
    const oldWrite = deferred<WriteResult>()
    mocks.eqUser.mockReturnValueOnce(oldWrite.promise)
    const { flush } = renderWithFlush()

    drag(900)
    await debounce()
    drag(1000)
    await debounce()
    // 第二批排在第一批後面，不並發（並發會逆序落庫）
    expect(mocks.eqUser).toHaveBeenCalledTimes(1)

    await act(async () => oldWrite.resolve({ error: null, count: 1 }))
    expect(await flush()).toBe(true)
    expect(mocks.update.mock.calls.map(([patch]) => patch.budget_max)).toEqual([900, 1000])

    // durable snapshot 要是 1000：下一筆失敗時還原到 1000，不是舊的 900
    mocks.eqUser.mockResolvedValueOnce(FAILED)
    drag(1100)
    await debounce()
    expect(alertText()).toBe(CONDITION_ERROR)
    expect(budget().value).toBe('1000')
  })

  it('flushPending 在 write failure 後維持 false，直到較新 generation 成功', async () => {
    mocks.eqUser.mockResolvedValueOnce(FAILED)
    const { flush } = renderWithFlush({ isHost: true })

    drag(900)
    expect(await flush()).toBe(false)
    expect(await flush()).toBe(false)
    drag(1000)
    expect(await flush()).toBe(true)
  })

  it('本地條件寫入失敗後收到權威 ready=true，仍可直接取消準備', async () => {
    mocks.eqUser.mockResolvedValueOnce({ error: { message: 'condition failed' }, count: 0 })
    const view = render(form())

    // Realtime ready=true 抵達前已排入的本地 generation；其失敗 gate 不得阻斷取消準備
    drag(900)
    view.rerender(form({ me: { ...me, ready: true } }))
    await debounce()
    expect(alertText()).toBe(CONDITION_ERROR)
    expect(budget().disabled).toBe(true)

    fireEvent.click(button('已準備（點擊取消）'))
    await settle()
    expect(mocks.rpc).toHaveBeenLastCalledWith('set_member_ready', {
      p_room_id: 'room-1', p_ready: false, p_search_version: 7,
    })
    // 取消成功只解除 ready 凍結；未 durable 的 condition gate 與可見 alert 必須保留
    expect(pressed(button('我準備好了'))).toBe('false')
    expect(alertText()).toBe(CONDITION_ERROR)

    drag(1000)
    await debounce()
    expect(alertText()).toBeNull()
  })

  it('條件批次寫入只含五個條件欄位，不夾帶 ready', async () => {
    render(form())
    drag(900)
    await debounce()

    expect(mocks.from).toHaveBeenCalledWith('room_members')
    const [payload, options] = mocks.update.mock.calls.at(-1)!
    expect(payload).toEqual({
      budget_max: 900, cuisines: [], dietary: [], max_distance_m: 1000,
      transport: 'walking',
    })
    expect(payload).not.toHaveProperty('ready')
    expect(options).toEqual({ count: 'exact' })
    expect(mocks.eqRoom).toHaveBeenCalledWith('room_id', 'room-1')
    expect(mocks.eqUser).toHaveBeenCalledWith('user_id', 'user-b')
  })

  it('legacy dietary 成員修改其他條件時只回寫 supported 值', async () => {
    render(form({ me: { ...me, dietary: ['no_beef', 'no_pork'] } }))
    drag(900)
    await debounce()

    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      budget_max: 900, dietary: [],
    }), { count: 'exact' })
  })

  it('legacy dietary 成員切換素食時只回寫 vegetarian', async () => {
    render(form({ me: { ...me, dietary: ['no_beef'] } }))
    fireEvent.click(button('素食'))
    expect(pressed(button('素食'))).toBe('true')
    await debounce()

    expect(mocks.update).toHaveBeenCalledWith(expect.objectContaining({
      dietary: ['vegetarian'],
    }), { count: 'exact' })
  })

  it('ready 點擊攜帶目前搜尋版本走專用 RPC，不等待 debounce', async () => {
    render(form())
    fireEvent.click(button('我準備好了'))
    await settle()

    expect(mocks.rpc).toHaveBeenCalledWith('set_member_ready', {
      p_room_id: 'room-1', p_ready: true, p_search_version: 7,
    })
    expect(mocks.update).not.toHaveBeenCalled()
    expect(pressed(button('已準備（點擊取消）'))).toBe('true')
    await debounce()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  // 準備要先等條件寫完，這段時間還沒凍結、手指還在拖：晚到的條件寫入成功，
  // 不能把 ready RPC 已確認的「已準備」從 durable snapshot 裡倒退掉
  it('pending 條件寫入成功不會倒退 ready 專用寫入保存的值', async () => {
    const first = deferred<WriteResult>()
    const second = deferred<WriteResult>()
    mocks.eqUser
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)
      .mockResolvedValueOnce(FAILED)
    render(form())

    drag(900)
    fireEvent.click(button('我準備好了'))
    await settle()
    drag(1000)
    await debounce() // 1000 排在 900 後面
    drag(1100) // 還在 debounce

    await act(async () => first.resolve({ error: null, count: 1 }))
    await settle()
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_ready', {
      p_room_id: 'room-1', p_ready: true, p_search_version: 7,
    })
    await act(async () => second.resolve({ error: null, count: 1 }))
    await settle()

    // 1100 寫入失敗：還原到 durable snapshot＝條件 1000＋已準備
    await debounce()
    expect(alertText()).toBe(CONDITION_ERROR)
    expect(budget().value).toBe('1000')
    expect(pressed(button('已準備（點擊取消）'))).toBe('true')
  })

  it.each([
    { data: false, error: null },
    { data: null, error: { message: 'denied' } },
  ])('ready RPC 未確認寫入時還原 ready 並顯示錯誤：%j', async result => {
    mocks.rpc.mockResolvedValue(result)
    render(form())
    fireEvent.click(button('我準備好了'))
    await settle()

    expect(pressed(button('我準備好了'))).toBe('false')
    expect(budget().disabled).toBe(false)
    expect(alertText()).toBe(READY_ERROR)
  })

  it('me.ready 變更的同步 effect 會把權威 ready 寫回 form（雙分頁凍結不被 stale 繞過）', async () => {
    const view = render(form())
    // 同成員的另一個分頁按了準備，Realtime 推來 ready=true
    view.rerender(form({ me: { ...me, ready: true } }))
    expect(pressed(button('已準備（點擊取消）'))).toBe('true')
    expect(budget().disabled).toBe(true)

    // 這個分頁再點是取消準備，不是拿 stale ready:false 再送一次準備
    fireEvent.click(button('已準備（點擊取消）'))
    await settle()
    expect(mocks.rpc).toHaveBeenCalledWith('set_member_ready', {
      p_room_id: 'room-1', p_ready: false, p_search_version: 7,
    })
  })

  it('條件 flush 期間地點版本改變，不送出舊準備請求', async () => {
    const condition = deferred<WriteResult>()
    mocks.eqUser.mockReturnValueOnce(condition.promise)
    const view = render(form())

    drag(900)
    fireEvent.click(button('我準備好了'))
    await settle()
    view.rerender(form({ searchVersion: 8 }))
    await act(async () => condition.resolve({ error: null, count: 1 }))
    await settle()

    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(pressed(button('我準備好了'))).toBe('false')
  })

  it('舊準備回應晚於新地點，不把新地點畫面改回已準備', async () => {
    const response = deferred<{ data: boolean; error: null }>()
    mocks.rpc.mockReturnValueOnce(response.promise)
    const view = render(form())

    fireEvent.click(button('我準備好了'))
    await settle()
    expect(pressed(button('已準備（點擊取消）'))).toBe('true') // 先樂觀凍結
    // 換地點：版本 8，Realtime 把全員 ready 歸零
    view.rerender(form({ searchVersion: 8 }))
    expect(pressed(button('我準備好了'))).toBe('false')

    await act(async () => response.resolve({ data: true, error: null }))
    await settle()
    expect(pressed(button('我準備好了'))).toBe('false')
    expect(alertText()).toBeNull()

    // durable snapshot 也不能記成已準備：之後條件寫入失敗還原時，畫面仍是未準備
    mocks.eqUser.mockResolvedValueOnce(FAILED)
    drag(900)
    await debounce()
    expect(alertText()).toBe(CONDITION_ERROR)
    expect(pressed(button('我準備好了'))).toBe('false')
  })

  it('準備 RPC 網路失敗會還原並顯示可重試錯誤', async () => {
    mocks.rpc.mockRejectedValueOnce(new Error('offline'))
    render(form())
    fireEvent.click(button('我準備好了'))
    await settle()

    expect(alertText()).toBe(READY_ERROR)
    expect(pressed(button('我準備好了'))).toBe('false')
    expect(budget().disabled).toBe(false)
  })
})

describe('ConditionsForm 凍結（準備／搜尋中）', () => {
  it('成員 ready 時所有條件輸入凍結、ready 鈕仍可點', () => {
    render(form({ me: { ...me, ready: true } }))
    expect(screen.getAllByRole('slider')).toHaveLength(2)
    expect(controls().filter(el => !el.disabled)).toEqual([button('已準備（點擊取消）')])
  })

  it('disabled prop（房主搜尋中）時全部輸入凍結', () => {
    render(form({ isHost: true, disabled: true }))
    expect(screen.queryByRole('button', { name: /準備/ })).toBeNull() // 房主無 ready 鈕
    expect(controls().every(el => el.disabled)).toBe(true)
  })

  it('未準備且未搜尋時可編輯', () => {
    render(form())
    expect(controls().length).toBeGreaterThan(0)
    expect(controls().filter(el => el.disabled)).toEqual([])
  })
})

describe('ConditionsForm 選取樣式', () => {
  it('選取的交通方式使用品牌實心色 classes（fill／on 成對，深色模式才看得到字）', () => {
    render(form({ isHost: true }))
    const walking = button('步行')
    expect(pressed(walking)).toBe('true')
    expect(walking.className).toContain('border-brand bg-brand-fill text-on-brand hover:bg-brand-fill-hover')
  })
})

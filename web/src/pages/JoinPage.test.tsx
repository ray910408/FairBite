// @vitest-environment jsdom
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { leaveRooms } from '../lib/api'
import { fetchLeaveRooms, type LeaveRoom } from '../lib/roomMembership'
import { getUid } from '../lib/uid'
import { deferred, Landing, settle } from '../test/dom'
import JoinPage, { validGuestNickname } from './JoinPage'

// 行為測試：真的 React hooks 跑在 jsdom 上，只在模組邊界 mock——lib/supabase（auth、兩支 RPC、
// 預設偏好寫入）、lib/api（離房）、lib/roomMembership（房籍查詢）、lib/uid。
// 離房確認框是真的 LeaveConfirm，斷言只看畫面與送出去的呼叫參數。

type InviteRow = { room_id: string; status: string; is_member: boolean }
type RpcResult<T> = { data: T | null; error: { message: string } | null }

const mocks = vi.hoisted(() => {
  const resolveInvite = vi.fn(async (_code: string): Promise<RpcResult<InviteRow[]>> =>
    ({ data: [{ room_id: 'new-room', status: 'lobby', is_member: false }], error: null }))
  const joinRoom = vi.fn(async (_code: string): Promise<RpcResult<string>> => ({ data: 'new-room', error: null }))
  // get_my_default_prefs：預設沒有存過偏好
  const defaultPrefs = vi.fn(async (): Promise<{ data: { default_prefs: unknown } | null; error: null }> =>
    ({ data: { default_prefs: null }, error: null }))
  const rpc = vi.fn((name: string, args?: { p_code: string }) => {
    if (name === 'resolve_room_invite') return resolveInvite(args!.p_code)
    if (name === 'join_room') return joinRoom(args!.p_code)
    return { single: defaultPrefs }
  })
  // supabase.from('room_members').update(...).eq(...)... 的替身：記下每個 eq，整條鏈被 await 時才寫入
  const update = vi.fn<(patch: unknown) => void>()
  const eq = vi.fn<(column: string, value: unknown) => void>()
  const write = vi.fn(async (): Promise<{ error: null }> => ({ error: null }))
  const from = vi.fn((_table: string) => ({
    update(patch: unknown) {
      update(patch)
      const chain = {
        eq(column: string, value: unknown) {
          eq(column, value)
          return chain
        },
        then: (resolve: (r: unknown) => unknown, reject?: (e: unknown) => unknown) => write().then(resolve, reject),
      }
      return chain
    },
  }))
  return {
    rpc, resolveInvite, joinRoom, defaultPrefs, from, update, eq, write,
    getSession: vi.fn(async (): Promise<{ data: { session: object | null } }> => ({ data: { session: {} } })),
    signInAnonymously: vi.fn(async (_credentials: unknown): Promise<{ error: Error | null }> => ({ error: null })),
  }
})

vi.mock('../lib/supabase', () => ({
  supabase: { rpc: mocks.rpc, from: mocks.from,
    auth: { getSession: mocks.getSession, signInAnonymously: mocks.signInAnonymously } },
}))
vi.mock('../lib/api')
vi.mock('../lib/uid')
vi.mock('../lib/roomMembership')

const leaveRoom = (id: string, code: string, stale = false): LeaveRoom =>
  ({ id, code, status: 'lobby', memberCount: 2, isHost: false, stale })
const inOldRoom = () => vi.mocked(fetchLeaveRooms).mockResolvedValueOnce([leaveRoom('old-room', 'OLD111')])

// 頁面外的兩條路：換一張邀請（同一個 JoinPage 換 :code）、離開這頁（JoinPage 卸載）
async function renderJoin() {
  const view = render(
    <MemoryRouter initialEntries={['/join/abc123']}>
      <Link to="/join/DEF456">換一張邀請</Link>
      <Link to="/elsewhere">離開這頁</Link>
      <Routes>
        <Route path="/join/:code" element={<JoinPage />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  )
  await settle()
  return view
}

const landed = () => screen.queryByText(/^到了 /)?.textContent ?? null
const dialog = () => screen.getByRole('dialog')
const departure = () => within(dialog()).getByRole<HTMLButtonElement>('button', { name: '離開並加入' })
const joinCalls = () => mocks.rpc.mock.calls.filter(([name]) => name === 'join_room')
const leavePage = () => fireEvent.click(screen.getByRole('link', { name: '離開這頁' }))
const switchInvite = () => fireEvent.click(screen.getByRole('link', { name: '換一張邀請' }))
const guestButton = () => screen.getByRole<HTMLButtonElement>('button', { name: '以訪客身分加入' })

function submitNickname(name: string) {
  fireEvent.change(screen.getByLabelText('你的暱稱'), { target: { value: name } })
  fireEvent.submit(guestButton().closest('form')!)
}

beforeEach(() => {
  vi.resetAllMocks()
  vi.mocked(getUid).mockResolvedValue(null)
  vi.mocked(leaveRooms).mockResolvedValue(undefined)
  vi.mocked(fetchLeaveRooms).mockResolvedValue([])
})

describe('訪客暱稱上限', () => {
  it('matches the database 80 Unicode-character boundary', () => {
    expect(validGuestNickname('  小明  ')).toBe(true)
    expect(validGuestNickname('😀'.repeat(80))).toBe(true)
    expect(validGuestNickname('😀'.repeat(81))).toBe(false)
    expect(validGuestNickname('   ')).toBe(false)
  })
})

describe('加入房間', () => {
  it('已登入：邀請碼正規化後解析、加入，取代掉加入頁導進新房', async () => {
    await renderJoin()
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'resolve_room_invite', { p_code: 'ABC123' })
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'join_room', { p_code: 'ABC123' })
    expect(landed()).toBe('到了 /room/new-room（REPLACE）')
  })

  it('沒登入：先問暱稱，以訪客身分登入後才解析邀請', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } })
    await renderJoin()
    expect(mocks.rpc).not.toHaveBeenCalled()
    submitNickname('  小明  ')
    await settle()

    expect(mocks.signInAnonymously).toHaveBeenCalledExactlyOnceWith({ options: { data: { display_name: '小明' } } })
    expect(mocks.rpc).toHaveBeenCalledWith('join_room', { p_code: 'ABC123' })
    expect(landed()).toBe('到了 /room/new-room（REPLACE）')
  })

  it('訪客登入失敗：留在暱稱表單，可以再送一次', async () => {
    mocks.getSession.mockResolvedValue({ data: { session: null } })
    mocks.signInAnonymously.mockResolvedValue({ error: new Error('captcha failed') })
    await renderJoin()
    submitNickname('小明')
    await settle()

    expect(screen.getByRole('alert').textContent).toBe('訪客登入失敗，請稍後再試')
    expect(guestButton().disabled).toBe(false)
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  // 房籍查不到還硬加入，就可能同時待在兩間（加入前必須先離開原房）：不猜，報錯等重試
  it.each([
    ['登入狀態查不到', '目前無法確認登入狀態，請稍後再試'],
    ['房籍查不到', '目前無法確認你的房間狀態，請稍後再試'],
    ['邀請解析斷線', '目前無法確認邀請，請檢查網路後再試'],
  ])('%s：不加入，給重試與回首頁', async (failure, message) => {
    if (failure === '登入狀態查不到') mocks.getSession.mockRejectedValue(new Error('offline'))
    if (failure === '房籍查不到') vi.mocked(fetchLeaveRooms).mockResolvedValue(null)
    if (failure === '邀請解析斷線') mocks.resolveInvite.mockRejectedValue(new TypeError('Failed to fetch'))
    await renderJoin()

    expect(screen.getByRole('alert').textContent).toBe(message)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(leaveRooms).not.toHaveBeenCalled()
    expect(joinCalls()).toHaveLength(0)
    expect(screen.getByRole('button', { name: '重新嘗試' })).toBeTruthy()
    expect(screen.getByRole('button', { name: '回首頁' })).toBeTruthy()
    expect(landed()).toBeNull()
  })

  it('已是成員就直接回房，不重套預設偏好', async () => {
    mocks.resolveInvite.mockResolvedValue({ data: [{ room_id: 'existing', status: 'pending', is_member: true }], error: null })
    await renderJoin()
    expect(landed()).toBe('到了 /room/existing（REPLACE）')
    expect(fetchLeaveRooms).not.toHaveBeenCalled()
    expect(joinCalls()).toHaveLength(0)
    expect(getUid).not.toHaveBeenCalled()
    expect(mocks.from).not.toHaveBeenCalled()
  })

  it('套用已存的允許料理到新成員列，寫完才導頁', async () => {
    vi.mocked(getUid).mockResolvedValue('member-1')
    mocks.defaultPrefs.mockResolvedValue({ data: { default_prefs: { cuisines: ['japanese', 'retired-tag'] } }, error: null })
    const write = deferred<{ error: null }>()
    mocks.write.mockReturnValue(write.promise)
    await renderJoin()

    expect(mocks.from).toHaveBeenCalledWith('room_members')
    expect(mocks.update).toHaveBeenCalledWith({ cuisines: ['japanese'] }) // 已下架的 tag 不帶入
    expect(mocks.eq.mock.calls).toEqual([['room_id', 'new-room'], ['user_id', 'member-1'], ['cuisines', '[]']])
    expect(landed()).toBeNull()

    await act(async () => write.resolve({ error: null }))
    await settle()
    expect(landed()).toBe('到了 /room/new-room（REPLACE）')
    expect(localStorage.getItem('prefs-applied:new-room:member-1')).toBe('1')
  })

  // 偏好只是附加步驟：storage 或請求出錯都不得擋住已經成功的加入
  it.each(['storage read', 'empty preference marker', 'saved preference marker', 'preference request'])
  ('偏好步驟失敗（%s）仍照常導進新房', async failure => {
    vi.mocked(getUid).mockResolvedValue('member-1')
    const unavailable = () => { throw new Error('Preference persistence unavailable') }
    if (failure === 'storage read') vi.spyOn(Storage.prototype, 'getItem').mockImplementation(unavailable)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(unavailable)
    mocks.defaultPrefs.mockImplementation(async () => {
      if (failure === 'preference request') unavailable()
      return { data: { default_prefs: { cuisines: failure === 'saved preference marker' ? ['japanese'] : [] } }, error: null }
    })
    await renderJoin()

    expect(mocks.rpc).toHaveBeenCalledWith('join_room', { p_code: 'ABC123' })
    expect(landed()).toBe('到了 /room/new-room（REPLACE）')
    if (failure === 'saved preference marker') {
      expect(mocks.update).toHaveBeenCalledWith({ cuisines: ['japanese'] })
      expect(mocks.eq.mock.calls).toEqual([['room_id', 'new-room'], ['user_id', 'member-1'], ['cuisines', '[]']])
    } else expect(mocks.update).not.toHaveBeenCalled()
  })

  it.each(['resolve_room_invite', 'join_room'])('%s 被節流：請使用者稍候', async limited => {
    const throttled = { data: null, error: { message: '嘗試過於頻繁，請稍後再試' } }
    if (limited === 'resolve_room_invite') mocks.resolveInvite.mockResolvedValue(throttled)
    else mocks.joinRoom.mockResolvedValue(throttled)
    await renderJoin()

    expect(screen.getByRole('alert').textContent).toBe('嘗試過於頻繁，請稍後再試')
    expect(screen.queryByText('正在確認邀請…')).toBeNull() // 等待結束
    expect(screen.getByRole('button', { name: '重新嘗試' })).toBeTruthy()
    expect(landed()).toBeNull()
    if (limited === 'resolve_room_invite') expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('錯誤畫面除了重試，也有回首頁的路', async () => {
    mocks.resolveInvite.mockResolvedValue({ data: null, error: { message: 'not found' } })
    await renderJoin()
    expect(screen.getByRole('alert').textContent).toBe('房間不存在或已開始')

    fireEvent.click(screen.getByRole('button', { name: '重新嘗試' }))
    await settle()
    expect(mocks.resolveInvite).toHaveBeenCalledTimes(2)

    fireEvent.click(screen.getByRole('button', { name: '回首頁' }))
    expect(landed()).toBe('到了 /（PUSH）')
  })
})

// 加入新房前必須先離開原房（不保留兩邊房籍），離席沒成功就不得加入
describe('確認離房後才加入', () => {
  it('還在別的房：開確認框、背景 inert，取消就回原房', async () => {
    inOldRoom()
    await renderJoin()
    const leave = dialog()
    expect(within(leave).getByRole('heading', { name: '你目前在另一個房間' })).toBeTruthy()
    expect(leave.textContent).toContain('你目前還在房間 OLD111 裡')
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('main').contains(leave)).toBe(false)
    expect(screen.queryByText('正在確認邀請…')).toBeNull()
    expect(joinCalls()).toHaveLength(0)

    const cancel = within(leave).getByRole('button', { name: '取消並回原房' })
    expect(document.activeElement).toBe(cancel) // 預設落在不會離房的那顆
    fireEvent.click(cancel)
    expect(landed()).toBe('到了 /room/old-room（REPLACE）')
    expect(leaveRooms).not.toHaveBeenCalled()
  })

  it.each(['HTTP 500', 'network failure', 'timeout'])('%s keeps the original room dialog and never joins', async message => {
    inOldRoom()
    vi.mocked(leaveRooms).mockRejectedValue(new Error(message))
    await renderJoin()
    fireEvent.click(departure())
    await settle()

    // 錯誤要顯示在還開著的確認框裡：背景整塊 inert，報讀與焦點都到不了外面那則
    expect(within(dialog()).getByRole('alert').textContent).toBe('原房間離席未完成；請重新確認房間狀態後再試')
    expect(departure().disabled).toBe(false)
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true)
    expect(mocks.resolveInvite).toHaveBeenCalledTimes(1) // 只有進頁那一次
    expect(fetchLeaveRooms).toHaveBeenCalledTimes(1)
    expect(joinCalls()).toHaveLength(0)
    expect(landed()).toBeNull()
  })

  it('resolves the invite and joins only after departure succeeds', async () => {
    inOldRoom()
    const leaving = deferred<void>()
    vi.mocked(leaveRooms).mockReturnValue(leaving.promise)
    const joining = deferred<RpcResult<string>>()
    mocks.joinRoom.mockReturnValue(joining.promise)
    await renderJoin()
    fireEvent.click(departure())
    await settle()
    expect(departure().disabled).toBe(true)
    expect(mocks.resolveInvite).toHaveBeenCalledTimes(1)

    await act(async () => leaving.resolve())
    await settle()
    // 離席落地：框收掉、重新解析邀請（房籍也重查）後才加入
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByText('正在確認邀請…')).toBeTruthy()
    expect(mocks.rpc.mock.calls.map(([name]) => name)).toEqual(['resolve_room_invite', 'resolve_room_invite', 'join_room'])
    expect(fetchLeaveRooms).toHaveBeenCalledTimes(2)

    await act(async () => joining.resolve({ data: 'new-room', error: null }))
    await settle()
    expect(landed()).toBe('到了 /room/new-room（REPLACE）')
  })

  // 殘留房（ADR-0007 2026-10-01 修訂）：比照首頁，全是過期房就不問，退了直接加入
  it('leaves only-stale rooms without asking, then joins', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValueOnce([leaveRoom('old-room', 'OLD111', true)])
    const leaving = deferred<void>()
    vi.mocked(leaveRooms).mockReturnValue(leaving.promise)
    await renderJoin()
    expect(leaveRooms).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(joinCalls()).toHaveLength(0)

    await act(async () => leaving.resolve())
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(mocks.rpc).toHaveBeenCalledWith('join_room', { p_code: 'ABC123' })
    expect(landed()).toBe('到了 /room/new-room（REPLACE）')
  })

  it('still asks when any room is not stale', async () => {
    // 只給一次：誤判成全殘留時會退房重查，第二次查到空房籍就直接加入，斷言才紅得乾淨（不會無限重試）
    vi.mocked(fetchLeaveRooms).mockResolvedValueOnce([leaveRoom('old-room', 'OLD111', true), leaveRoom('live-room', 'LIVE22')])
    await renderJoin()
    const text = dialog().textContent
    expect(text).toContain('你目前在 2 個房間裡')
    expect(text).toContain('房間 OLD111')
    expect(text).toContain('房間 LIVE22')
    expect(leaveRooms).not.toHaveBeenCalled()
    expect(joinCalls()).toHaveLength(0)
  })

  it('多房時不替使用者猜回哪一間：沒有「取消並回原房」，從各房的回房鈕回去', async () => {
    vi.mocked(fetchLeaveRooms).mockResolvedValueOnce([leaveRoom('first-room', 'FIRST1'), leaveRoom('second-room', 'SECND2')])
    await renderJoin()
    expect(within(dialog()).queryByRole('button', { name: '取消並回原房' })).toBeNull()
    // 預設落在不會離房的那顆
    expect(document.activeElement).toBe(within(dialog()).getByRole('button', { name: '回到 FIRST1' }))

    fireEvent.click(within(dialog()).getByRole('button', { name: '回到 SECND2' }))
    expect(landed()).toBe('到了 /room/second-room（REPLACE）') // 上一頁不再回到加入頁
    expect(leaveRooms).not.toHaveBeenCalled()
  })
})

// 每一輪路由（:code）各自擁有自己的非同步工作：離頁或換邀請碼後，舊的那一輪晚到也不得再動作
describe('邀請世代守衛', () => {
  it.each(['resolution', 'memberships', 'join'])('ignores late %s after unmount', async stage => {
    const resolution = deferred<RpcResult<InviteRow[]>>()
    const memberships = deferred<LeaveRoom[] | null>()
    const joined = deferred<RpcResult<string>>()
    if (stage === 'resolution') mocks.resolveInvite.mockReturnValue(resolution.promise)
    if (stage === 'memberships') vi.mocked(fetchLeaveRooms).mockReturnValue(memberships.promise)
    if (stage === 'join') mocks.joinRoom.mockReturnValue(joined.promise)
    await renderJoin()
    if (stage === 'resolution') expect(mocks.rpc).toHaveBeenCalledWith('resolve_room_invite', { p_code: 'ABC123' })
    if (stage === 'memberships') expect(fetchLeaveRooms).toHaveBeenCalled()
    if (stage === 'join') expect(mocks.rpc).toHaveBeenCalledWith('join_room', { p_code: 'ABC123' })

    leavePage()
    expect(landed()).toBe('到了 /elsewhere（PUSH）')
    await act(async () => {
      resolution.resolve({ data: [{ room_id: 'old-room', status: 'lobby', is_member: false }], error: null })
      memberships.resolve([])
      joined.resolve({ data: 'old-room', error: null })
    })
    await settle()
    expect(landed()).toBe('到了 /elsewhere（PUSH）')
    expect(getUid).not.toHaveBeenCalled() // 沒有替舊房套預設偏好
    if (stage !== 'join') expect(joinCalls()).toHaveLength(0)
  })

  it('套預設偏好途中離頁：寫完也不再導進新房', async () => {
    vi.mocked(getUid).mockResolvedValue('member-1')
    mocks.defaultPrefs.mockResolvedValue({ data: { default_prefs: { cuisines: ['japanese'] } }, error: null })
    const write = deferred<{ error: null }>()
    mocks.write.mockReturnValue(write.promise)
    await renderJoin()
    expect(mocks.update).toHaveBeenCalledWith({ cuisines: ['japanese'] })

    leavePage()
    await act(async () => write.resolve({ error: null }))
    await settle()
    expect(landed()).toBe('到了 /elsewhere（PUSH）')
  })

  it('換邀請碼時收掉舊邀請的離房確認，重新確認新邀請', async () => {
    inOldRoom()
    const fresh = deferred<RpcResult<InviteRow[]>>()
    mocks.resolveInvite.mockImplementation(async code => code === 'ABC123'
      ? { data: [{ room_id: 'new-room', status: 'lobby', is_member: false }], error: null }
      : fresh.promise)
    await renderJoin()
    expect(dialog()).toBeTruthy()

    switchInvite()
    await settle()
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false)
    expect(screen.getByText('正在確認邀請…')).toBeTruthy()
  })

  // 換邀請碼不會卸載頁面：舊那一輪晚到的錯誤若沒擋，會掛在新邀請的畫面上
  it('換邀請碼後，舊邀請晚到的錯誤不顯示在新邀請上', async () => {
    const old = deferred<RpcResult<InviteRow[]>>()
    const fresh = deferred<RpcResult<InviteRow[]>>()
    mocks.resolveInvite.mockImplementation(code => code === 'ABC123' ? old.promise : fresh.promise)
    await renderJoin()
    switchInvite()
    await settle()
    expect(screen.getByRole('heading', { name: '加入房間 DEF456' })).toBeTruthy()

    await act(async () => old.resolve({ data: null, error: { message: 'not found' } }))
    await settle()
    expect(screen.queryByRole('alert')).toBeNull()
    expect(screen.getByText('正在確認邀請…')).toBeTruthy()
  })

  it('only joins the latest invite when the route code changes', async () => {
    const old = deferred<RpcResult<InviteRow[]>>()
    mocks.resolveInvite.mockImplementation(async code => code === 'ABC123'
      ? old.promise
      : { data: [{ room_id: 'newest', status: 'lobby', is_member: false }], error: null })
    mocks.joinRoom.mockImplementation(async code => ({ data: code === 'ABC123' ? 'old' : 'newest', error: null }))
    await renderJoin()
    expect(mocks.rpc).toHaveBeenCalledTimes(1)

    switchInvite()
    await settle()
    expect(landed()).toBe('到了 /room/newest（REPLACE）')
    const key = screen.getByText(/^到了 /).dataset.key

    await act(async () => old.resolve({ data: [{ room_id: 'old', status: 'lobby', is_member: false }], error: null }))
    await settle()
    expect(mocks.rpc).not.toHaveBeenCalledWith('join_room', { p_code: 'ABC123' })
    expect(mocks.rpc).toHaveBeenCalledWith('join_room', { p_code: 'DEF456' })
    expect(screen.getByText(/^到了 /).dataset.key).toBe(key)
  })

  // 換邀請碼那條：頁面還在，舊動作落地後若沒擋，會把新邀請的暱稱表單／離房確認收掉，畫面卡在空白
  it.each([
    ['guest', '離頁'], ['guest', '換邀請碼'], ['departure', '離頁'], ['departure', '換邀請碼'],
  ] as const)('does not resume the old invite after an in-flight %s action（%s）', async (action, exit) => {
    const signIn = deferred<{ error: null }>()
    const leaving = deferred<void>()
    if (action === 'guest') {
      mocks.getSession.mockResolvedValue({ data: { session: null } })
      mocks.signInAnonymously.mockReturnValue(signIn.promise)
    } else {
      // 離席還沒落地：房籍查詢一直看得到原房
      vi.mocked(fetchLeaveRooms).mockResolvedValue([leaveRoom('old-room', 'OLD111')])
      vi.mocked(leaveRooms).mockReturnValue(leaving.promise)
    }
    await renderJoin()
    if (action === 'guest') submitNickname('小明')
    else fireEvent.click(departure())
    await settle()

    if (exit === '離頁') leavePage()
    else switchInvite()
    await settle()
    await act(async () => {
      signIn.resolve({ error: null })
      leaving.resolve()
    })
    await settle()

    // 舊邀請只在進頁時解析過那一次（訪客連那次都沒有）
    const oldResolutions = mocks.resolveInvite.mock.calls.filter(([code]) => code === 'ABC123')
    expect(oldResolutions).toHaveLength(action === 'guest' ? 0 : 1)
    expect(joinCalls()).toHaveLength(0)
    if (exit === '離頁') expect(landed()).toBe('到了 /elsewhere（PUSH）')
    else {
      expect(screen.getByRole('heading', { name: '加入房間 DEF456' })).toBeTruthy()
      if (action === 'guest') expect(guestButton().disabled).toBe(false)
      else expect(departure().disabled).toBe(false)
    }
  })
})

import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  values: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[],
  leaveRooms: vi.fn(),
  rpc: vi.fn(),
  fetchLeaveRooms: vi.fn(),
  navigate: vi.fn(),
  leaveConfirm: vi.fn(),
}))

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: vi.fn(),
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++
    const setter = vi.fn()
    mocks.setters[index] = setter
    return [index < mocks.values.length ? mocks.values[index] : initial, setter]
  },
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ code: 'ABC123' }),
}))
// Unit tests must never initialize the real client or depend on developer .env files.
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocks.rpc } }))
vi.mock('../lib/api', () => ({ leaveRooms: mocks.leaveRooms }))
vi.mock('../lib/roomMembership', () => ({ fetchLeaveRooms: mocks.fetchLeaveRooms }))
vi.mock('../components/LeaveConfirm', () => ({
  LeaveConfirm: mocks.leaveConfirm,
  LeaveRoomsBody: () => null,
}))

import JoinPage, { validGuestNickname } from './JoinPage'

describe('guest nickname boundary', () => {
  it('matches the database 80 Unicode-character boundary', () => {
    expect(validGuestNickname('  小明  ')).toBe(true)
    expect(validGuestNickname('😀'.repeat(80))).toBe(true)
    expect(validGuestNickname('😀'.repeat(81))).toBe(false)
    expect(validGuestNickname('   ')).toBe(false)
  })
})

describe('join after confirmed departure', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.stateIndex = 0
    mocks.setters = []
    mocks.values = ['', false, { kind: 'rooms', rooms: [{ id: 'old-room' }] }, false, '']
    mocks.leaveRooms.mockResolvedValue(undefined)
    mocks.fetchLeaveRooms.mockResolvedValue([])
    mocks.rpc.mockImplementation(async (name: string) => ({
      data: name === 'resolve_room_invite'
        ? [{ room_id: 'new-room', status: 'lobby', is_member: false }]
        : 'new-room',
      error: null,
    }))
  })

  function confirmDeparture(): Promise<void> {
    JoinPage()
    const { actions } = mocks.leaveConfirm.mock.calls[0][0]
    return actions.props.children[1].props.onClick()
  }

  it.each(['HTTP 500', 'network failure', 'timeout'])('%s keeps the original room dialog and never joins', async message => {
    mocks.leaveRooms.mockRejectedValue(new Error(message))
    await confirmDeparture()
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.fetchLeaveRooms).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.setters[2]).not.toHaveBeenCalledWith(null)
    expect(mocks.setters[3]).toHaveBeenLastCalledWith(false)
    expect(mocks.setters[4]).toHaveBeenLastCalledWith('原房間離席未完成；請重新確認房間狀態後再試')
  })

  it('resolves the invite and joins only after departure succeeds', async () => {
    await confirmDeparture()
    expect(mocks.setters[2]).toHaveBeenCalledWith(null)
    expect(mocks.rpc).toHaveBeenNthCalledWith(1, 'resolve_room_invite', { p_code: 'ABC123' })
    expect(mocks.rpc).toHaveBeenNthCalledWith(2, 'join_room', { p_code: 'ABC123' })
    expect(mocks.navigate).toHaveBeenCalledWith('/room/new-room', { replace: true })
  })

  it.each(['resolve_room_invite', 'join_room'])('%s throttling tells users to wait', async limitedRpc => {
    mocks.rpc.mockImplementation(async (name: string) => name === limitedRpc
      ? { data: null, error: { message: '嘗試過於頻繁，請稍後再試' } }
      : { data: [{ room_id: 'new-room', status: 'lobby', is_member: false }], error: null })
    await confirmDeparture()
    expect(mocks.setters[4]).toHaveBeenLastCalledWith('嘗試過於頻繁，請稍後再試')
    expect(mocks.setters[3]).toHaveBeenLastCalledWith(false)
    expect(mocks.navigate).not.toHaveBeenCalled()
    if (limitedRpc === 'resolve_room_invite') expect(mocks.rpc).toHaveBeenCalledTimes(1)
  })

  it('departure errors are visible inside the active dialog', () => {
    mocks.values[4] = '原房間離席失敗'
    JoinPage()
    const { children } = mocks.leaveConfirm.mock.calls[0][0]
    expect(children.props.children[0].props.role).toBe('alert')
    expect(children.props.children[0].props.children).toBe('原房間離席失敗')
  })
})

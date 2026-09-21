import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  values: [] as unknown[],
  setters: [] as ReturnType<typeof vi.fn>[],
  leaveRooms: vi.fn(),
  rpc: vi.fn(),
  fetchLeaveRooms: vi.fn(),
  navigate: vi.fn(),
  leaveConfirm: vi.fn(),
  getUid: vi.fn(),
  from: vi.fn(),
  getSession: vi.fn(),
  signInAnonymously: vi.fn(),
  code: 'ABC123',
  effects: [] as Array<() => void | (() => void)>,
  generation: { current: 0 },
}))

vi.mock('react', async importOriginal => ({
  ...await importOriginal<typeof import('react')>(),
  useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
  useRef: () => mocks.generation,
  useState: (initial: unknown) => {
    const index = mocks.stateIndex++
    const setter = vi.fn()
    mocks.setters[index] = setter
    return [index < mocks.values.length ? mocks.values[index] : initial, setter]
  },
}))
vi.mock('react-router-dom', () => ({
  useNavigate: () => mocks.navigate,
  useParams: () => ({ code: mocks.code }),
}))
// Unit tests must never initialize the real client or depend on developer .env files.
vi.mock('../lib/supabase', () => ({ supabase: { rpc: mocks.rpc, from: mocks.from,
  auth: { getSession: mocks.getSession, signInAnonymously: mocks.signInAnonymously } } }))
vi.mock('../lib/uid', () => ({ getUid: mocks.getUid }))
vi.mock('../lib/api', () => ({ leaveRooms: mocks.leaveRooms }))
vi.mock('../lib/roomMembership', () => ({ fetchLeaveRooms: mocks.fetchLeaveRooms }))
vi.mock('../components/LeaveConfirm', () => ({
  LeaveConfirm: mocks.leaveConfirm,
  LeaveRoomsBody: () => null,
}))

import JoinPage, { validGuestNickname } from './JoinPage'

afterEach(() => vi.unstubAllGlobals())

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
    mocks.effects = []
    mocks.generation.current = 0
    mocks.code = 'ABC123'
    mocks.getSession.mockResolvedValue({ data: { session: {} } })
    mocks.setters = []
    mocks.values = ['', false, { kind: 'rooms', rooms: [{ id: 'old-room' }] }, false, '']
    mocks.leaveRooms.mockResolvedValue(undefined)
    mocks.fetchLeaveRooms.mockResolvedValue([])
    mocks.getUid.mockResolvedValue(null)
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

  it('applies saved allowed cuisines to the new member before navigating', async () => {
    mocks.getUid.mockResolvedValue('member-1')
    vi.stubGlobal('localStorage', { getItem: vi.fn(), setItem: vi.fn() })
    let finishWrite!: (value: { error: null }) => void
    const write = new Promise(resolve => { finishWrite = resolve })
    const eq = vi.fn().mockReturnThis()
    eq.mockImplementationOnce(() => ({ eq })).mockImplementationOnce(() => ({ eq }))
      .mockImplementationOnce(() => write)
    const update = vi.fn(() => ({ eq }))
    mocks.from.mockReturnValue({ update })
    const joinRpc = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementation((name: string) => name === 'get_my_default_prefs'
      ? { single: async () => ({ data: { default_prefs: { cuisines: ['japanese', 'retired-tag'] } }, error: null }) }
      : joinRpc(name))
    const joining = confirmDeparture()
    await vi.waitFor(() => expect(update).toHaveBeenCalledWith({ cuisines: ['japanese'] }))
    expect(eq.mock.calls).toEqual([['room_id', 'new-room'], ['user_id', 'member-1'], ['cuisines', '[]']])
    expect(mocks.navigate).not.toHaveBeenCalled()
    finishWrite({ error: null })
    await joining
    expect(mocks.navigate).toHaveBeenCalledWith('/room/new-room', { replace: true })
    expect(localStorage.setItem).toHaveBeenCalledWith('prefs-applied:new-room:member-1', '1')
  })

  it('does not reapply preferences when resuming existing membership', async () => {
    mocks.rpc.mockResolvedValue({ data: [{ room_id: 'existing', status: 'pending', is_member: true }], error: null })
    await confirmDeparture()
    expect(mocks.getUid).not.toHaveBeenCalled()
    expect(mocks.from).not.toHaveBeenCalled()
    expect(mocks.navigate).toHaveBeenCalledWith('/room/existing', { replace: true })
  })

  it.each(['resolution', 'memberships', 'join'])('ignores late %s after unmount', async stage => {
    let finish!: (value: unknown) => void
    const pending = new Promise(resolve => { finish = resolve })
    if (stage === 'memberships') mocks.fetchLeaveRooms.mockReturnValue(pending)
    const rpc = mocks.rpc.getMockImplementation()!
    mocks.rpc.mockImplementation((name: string) =>
      (stage === 'resolution' && name === 'resolve_room_invite') || (stage === 'join' && name === 'join_room')
        ? pending : rpc(name))
    JoinPage()
    const cleanup = mocks.effects[0]()
    await vi.waitFor(() => {
      if (stage === 'resolution') expect(mocks.rpc).toHaveBeenCalledWith('resolve_room_invite', { p_code: 'ABC123' })
      if (stage === 'memberships') expect(mocks.fetchLeaveRooms).toHaveBeenCalled()
      if (stage === 'join') expect(mocks.rpc).toHaveBeenCalledWith('join_room', { p_code: 'ABC123' })
    })
    if (typeof cleanup === 'function') cleanup()
    mocks.setters.forEach(setter => setter.mockClear())
    finish(stage === 'memberships' ? [] : { data: stage === 'join' ? 'old-room'
      : [{ room_id: 'old-room', status: 'lobby', is_member: false }], error: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.navigate).not.toHaveBeenCalled()
    expect(mocks.getUid).not.toHaveBeenCalled()
    if (stage !== 'join') expect(mocks.rpc).not.toHaveBeenCalledWith('join_room', expect.anything())
    mocks.setters.forEach(setter => expect(setter).not.toHaveBeenCalled())
  })

  it('only joins the latest invite when the route code changes', async () => {
    let finishOld!: (value: unknown) => void
    const oldResolution = new Promise(resolve => { finishOld = resolve })
    mocks.rpc.mockImplementation((name: string, args: { p_code: string }) => {
      if (args.p_code === 'ABC123') return oldResolution
      return Promise.resolve({ data: name === 'resolve_room_invite'
        ? [{ room_id: 'newest', status: 'lobby', is_member: false }] : 'newest', error: null })
    })
    JoinPage()
    const cleanup = mocks.effects[0]()
    await vi.waitFor(() => expect(mocks.rpc).toHaveBeenCalledTimes(1))
    if (typeof cleanup === 'function') cleanup()
    mocks.code = 'DEF456'
    mocks.stateIndex = 0
    JoinPage()
    mocks.effects[1]()
    await vi.waitFor(() => expect(mocks.navigate).toHaveBeenCalledWith('/room/newest', { replace: true }))
    finishOld({ data: [{ room_id: 'old', status: 'lobby', is_member: false }], error: null })
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(mocks.rpc).not.toHaveBeenCalledWith('join_room', { p_code: 'ABC123' })
    expect(mocks.rpc).toHaveBeenCalledWith('join_room', { p_code: 'DEF456' })
    expect(mocks.navigate).toHaveBeenCalledTimes(1)
  })

  it.each(['guest', 'departure'])('does not resume the old invite after an in-flight %s action', async action => {
    let finish!: (value: { error: null }) => void
    const pending = new Promise(resolve => { finish = resolve })
    // Keep the automatic session check pending so only the user action starts work.
    mocks.getSession.mockReturnValue(new Promise(() => {}))
    mocks.values[0] = '小明'
    mocks.values[1] = true
    mocks.signInAnonymously.mockReturnValue(pending)
    mocks.leaveRooms.mockReturnValue(pending)
    const tree = JoinPage()
    const cleanup = mocks.effects[0]()
    const joining = action === 'guest'
      ? tree.props.children[0].props.children[2].props.onSubmit({ preventDefault: vi.fn() })
      : mocks.leaveConfirm.mock.calls[0][0].actions.props.children[1].props.onClick()
    if (typeof cleanup === 'function') cleanup()
    mocks.setters.forEach(setter => setter.mockClear())
    finish({ error: null })
    await joining
    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
    mocks.setters.forEach(setter => expect(setter).not.toHaveBeenCalled())
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

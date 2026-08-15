import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as Array<() => void | (() => void)>,
  getUid: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  navigate: vi.fn(),
  saveLastDeparture: vi.fn(),
  leaveRooms: vi.fn(),
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = mocks.stateIndex++
      const value = mocks.stateValues[index] === undefined ? initial : mocks.stateValues[index]
      const setter = vi.fn()
      mocks.stateSetters[index] = setter
      return [value, setter]
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
    useCallback: (fn: unknown) => fn,
  }
})

vi.mock('react-router-dom', () => ({
  Link: 'a',
  useNavigate: () => mocks.navigate,
}))

vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signOut: vi.fn() }, rpc: mocks.rpc, from: mocks.from },
}))
vi.mock('../lib/uid', () => ({ getUid: mocks.getUid }))
vi.mock('../lib/api', () => ({ leaveRooms: mocks.leaveRooms }))

vi.mock('../lib/departure', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/departure')>()
  return { ...actual, saveLastDeparture: mocks.saveLastDeparture }
})

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
  return findButton(element.props?.children, label)
}

function findSections(node: unknown, out: ElementLike[] = []): ElementLike[] {
  if (Array.isArray(node)) {
    for (const child of node) findSections(child, out)
    return out
  }
  if (!node || typeof node !== 'object') return out
  const element = node as ElementLike
  if (element.type === 'section') out.push(element)
  findSections(element.props?.children, out)
  return out
}

async function clickCreateRoom() {
  const { default: HomePage } = await import('./HomePage')
  const tree = HomePage()
  const button = findButton(tree, '建立房間')
  if (!button.props?.onClick) throw new Error('找不到建立房間按鈕')
  await button.props.onClick()
}

describe('HomePage persistRoom', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.stateValues = [
      '', '', '', '', { lat: 25.0478, lng: 121.517, label: '台北車站' },
      'now', '', '', false, '', {}, [],
    ]
    mocks.getUid.mockReset()
    mocks.rpc.mockReset().mockResolvedValue({ data: 'room-1', error: null })
    mocks.from.mockReset().mockImplementation(() => {
      throw new Error('已套用偏好時不應查表')
    })
    mocks.navigate.mockReset()
    mocks.saveLastDeparture.mockReset()
    vi.stubGlobal('localStorage', {
      getItem: vi.fn(() => '1'),
      setItem: vi.fn(),
    })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('以發起建房時的 uid 儲存出發點，不受 pending 期間換帳號影響', async () => {
    mocks.getUid
      .mockResolvedValueOnce('creator')
      .mockResolvedValue('replacement')

    await clickCreateRoom()

    expect(mocks.getUid.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0])
    expect(mocks.saveLastDeparture).toHaveBeenCalledWith('creator', {
      lat: 25.0478, lng: 121.517, label: '台北車站',
    })
  })

  it('發起時未登入便不建立房間', async () => {
    mocks.getUid.mockResolvedValue(null)

    await clickCreateRoom()

    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.saveLastDeparture).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

describe('HomePage 錯誤就地顯示（QA ISSUE-003）', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.getUid.mockReset().mockResolvedValue('creator')
    mocks.rpc.mockReset()
    mocks.from.mockReset()
    mocks.navigate.mockReset()
    mocks.saveLastDeparture.mockReset()
    vi.stubGlobal('localStorage', { getItem: vi.fn(() => '1'), setItem: vi.fn() })
  })
  afterEach(() => vi.unstubAllGlobals())

  it('自訂時間未選完整就按建立房間：不打 API', async () => {
    mocks.stateValues = [
      '', '', '', '', { lat: 25.0478, lng: 121.517, label: '台北車站' },
      'custom', '', '', false, '', {}, [],
    ]
    await clickCreateRoom()
    expect(mocks.rpc).not.toHaveBeenCalled()
  })

  it('建房錯誤渲染在建立房間的卡片內，不在頁尾', async () => {
    mocks.stateValues = [
      '', '請選擇完整的用餐時間', '', '', { lat: 25.0478, lng: 121.517, label: '台北車站' },
      'custom', '', '', false, '', {}, [],
    ]
    const { default: HomePage } = await import('./HomePage')
    const sections = findSections(HomePage())
    expect(textContent(sections[0])).toContain('請選擇完整的用餐時間')
    expect(textContent(sections[1])).not.toContain('請選擇完整的用餐時間')
  })
})

describe('HomePage 退房閘門', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.stateValues = []
    mocks.stateSetters = []
    mocks.effects = []
    mocks.getUid.mockReset().mockResolvedValue('user-1')
    mocks.leaveRooms.mockReset()
    mocks.from.mockReset().mockReturnValue({
      select: vi.fn().mockReturnValue({
        eq: vi.fn().mockReturnValue({ single: vi.fn().mockResolvedValue({ data: null }) }),
        order: vi.fn().mockReturnValue({ limit: vi.fn().mockResolvedValue({ data: [] }) }),
        lte: vi.fn().mockResolvedValue({ data: [] }),
      }),
    })
  })

  function findButtonAnywhere(tree: unknown, label: string) {
    const button = findButton(tree, label)
    if (!button.type) throw new Error(`找不到按鈕：${label}`)
    return button as { props: { disabled?: boolean } }
  }

  it('leave 未 settle 前建立房間與加入都禁用', async () => {
    mocks.stateValues = []
    mocks.stateValues[4] = { lat: 25.0478, lng: 121.517 }
    const { default: HomePage } = await import('./HomePage')
    const tree = HomePage()
    expect(findButtonAnywhere(tree, '建立房間').props.disabled).toBe(true)
    expect(findButtonAnywhere(tree, '加入').props.disabled).toBe(true)
  })

  it('leave settle 後兩鈕解禁', async () => {
    mocks.stateValues = []
    mocks.stateValues[4] = { lat: 25.0478, lng: 121.517 }
    mocks.stateValues[12] = false
    const { default: HomePage } = await import('./HomePage')
    const tree = HomePage()
    expect(findButtonAnywhere(tree, '建立房間').props.disabled).toBe(false)
    expect(findButtonAnywhere(tree, '加入').props.disabled).toBe(false)
  })

  it('mount effect 呼叫 leaveRooms，settle 後解禁 leavePending', async () => {
    mocks.stateIndex = 0
    mocks.stateValues = []
    mocks.effects.length = 0
    mocks.leaveRooms.mockResolvedValue(undefined)
    const { default: HomePage } = await import('./HomePage')
    HomePage()
    for (const fn of mocks.effects) fn()
    await vi.waitFor(() => expect(mocks.leaveRooms).toHaveBeenCalledTimes(1))
    await Promise.resolve()
    expect(mocks.stateSetters[12]).toHaveBeenCalledWith(false)
  })
})

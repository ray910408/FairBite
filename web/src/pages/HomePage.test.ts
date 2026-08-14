import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
  getUser: vi.fn(),
  rpc: vi.fn(),
  from: vi.fn(),
  navigate: vi.fn(),
  saveLastDeparture: vi.fn(),
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const index = mocks.stateIndex++
      const value = index < mocks.stateValues.length ? mocks.stateValues[index] : initial
      return [value, vi.fn()]
    },
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: vi.fn(),
    useCallback: (fn: unknown) => fn,
  }
})

vi.mock('react-router-dom', () => ({
  Link: 'a',
  useNavigate: () => mocks.navigate,
}))

vi.mock('../lib/supabase', () => ({
  supabase: {
    auth: { getUser: mocks.getUser },
    rpc: mocks.rpc,
    from: mocks.from,
  },
}))

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
      '', '', { lat: 25.0478, lng: 121.517, label: '台北車站' },
      'now', '', '', false, '', {}, [],
    ]
    mocks.getUser.mockReset()
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
    mocks.getUser
      .mockResolvedValueOnce({ data: { user: { id: 'creator' } } })
      .mockResolvedValueOnce({ data: { user: { id: 'replacement' } } })
      .mockResolvedValue({ data: { user: { id: 'replacement' } } })

    await clickCreateRoom()

    expect(mocks.getUser.mock.invocationCallOrder[0]).toBeLessThan(mocks.rpc.mock.invocationCallOrder[0])
    expect(mocks.saveLastDeparture).toHaveBeenCalledWith('creator', {
      lat: 25.0478, lng: 121.517, label: '台北車站',
    })
  })

  it('發起時未登入便不建立房間', async () => {
    mocks.getUser.mockResolvedValue({ data: { user: null } })

    await clickCreateRoom()

    expect(mocks.rpc).not.toHaveBeenCalled()
    expect(mocks.saveLastDeparture).not.toHaveBeenCalled()
    expect(mocks.navigate).not.toHaveBeenCalled()
  })
})

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  useRoom: vi.fn(),
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
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
    useRef: (initial: unknown) => ({ current: initial }),
    useEffect: vi.fn(),
  }
})

vi.mock('react-router-dom', () => ({
  Link: 'a',
  useParams: () => ({ id: 'room-1' }),
}))

vi.mock('../hooks/useRoom', () => ({ useRoom: mocks.useRoom }))

vi.mock('../lib/supabase', () => ({
  supabase: {
    from: mocks.from,
  },
}))

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

async function renderRoomPage() {
  const { default: RoomPage } = await import('./RoomPage')
  return RoomPage()
}

describe('RoomPage meal_time draft intent', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    mocks.stateIndex = 0
    mocks.stateValues = [false, '', '', false, false, '', '']
    mocks.stateSetters = []
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
})

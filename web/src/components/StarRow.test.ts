import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  stateIndex: 0,
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  from: vi.fn(),
  update: vi.fn(),
  eq: vi.fn(),
  is: vi.fn(),
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: unknown) => {
      const setter = vi.fn()
      mocks.stateSetters[mocks.stateIndex++] = setter
      return [initial, setter]
    },
  }
})

vi.mock('../lib/supabase', () => ({ supabase: { from: mocks.from } }))

type ElementLike = {
  type?: unknown
  props?: { children?: unknown; 'aria-label'?: string; onClick?: () => void | Promise<void> }
}

// 星星按鈕內只有 icon 沒有文字，改用 aria-label 尋找
function findStar(node: unknown, label: string): ElementLike {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findStar(child, label)
      if (found.type) return found
    }
    return {}
  }
  if (!node || typeof node !== 'object') return {}
  const element = node as ElementLike
  if (element.type === 'button' && element.props?.['aria-label'] === label) return element
  return findStar(element.props?.children, label)
}

describe('StarRow 評分寫入防線', () => {
  beforeEach(() => {
    mocks.stateIndex = 0
    mocks.stateSetters = []
    mocks.is.mockReset().mockResolvedValue({ error: null, count: 1 })
    mocks.eq.mockReset().mockReturnValue({ is: mocks.is })
    mocks.update.mockReset().mockReturnValue({ eq: mocks.eq })
    mocks.from.mockReset().mockReturnValue({ update: mocks.update })
  })

  async function clickStar(onRated: (n: number) => void) {
    const { default: StarRow } = await import('./StarRow')
    const tree = StarRow({ historyId: 'h-1', onRated })
    const star = findStar(tree, '3 顆星')
    if (!star.props?.onClick) throw new Error('找不到星星按鈕')
    await star.props.onClick()
  }

  it('點星鎖定 id 且僅寫入未評分列', async () => {
    const onRated = vi.fn()
    await clickStar(onRated)
    expect(mocks.update).toHaveBeenCalledWith({ rating: 3 }, { count: 'exact' })
    expect(mocks.eq).toHaveBeenCalledWith('id', 'h-1')
    expect(mocks.is).toHaveBeenCalledWith('rating', null)
    expect(onRated).toHaveBeenCalledWith(3)
  })

  it('count 0（已評過）時顯示錯誤、解除 busy 且不觸發 onRated', async () => {
    mocks.is.mockResolvedValue({ error: null, count: 0 })
    const onRated = vi.fn()
    await clickStar(onRated)
    expect(mocks.stateSetters[0]).toHaveBeenCalledWith('評分未儲存：這筆可能已評過，請重新整理')
    expect(mocks.stateSetters[1]).toHaveBeenCalledWith(false)
    expect(onRated).not.toHaveBeenCalled()
  })
})

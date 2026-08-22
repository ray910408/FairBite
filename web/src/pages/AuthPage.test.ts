import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
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
  }
})
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }))
vi.mock('../lib/supabase', () => ({
  supabase: { auth: { signUp: vi.fn(), signInWithPassword: vi.fn() } },
}))

type NodeLike = { type?: unknown; props?: Record<string, unknown> }

function textContent(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textContent).join('')
  if (node && typeof node === 'object') return textContent((node as NodeLike).props?.children)
  return ''
}

function findButton(node: unknown, label: string): NodeLike | undefined {
  if (Array.isArray(node)) {
    for (const child of node) {
      const found = findButton(child, label)
      if (found) return found
    }
    return undefined
  }
  if (!node || typeof node !== 'object') return undefined
  const element = node as NodeLike
  if (element.type === 'button' && textContent(element) === label) return element
  return findButton(element.props?.children, label)
}

describe('AuthPage segmented control', () => {
  beforeEach(() => {
    mocks.navigate.mockReset()
    mocks.stateIndex = 0
    mocks.stateValues = []
    mocks.stateSetters = []
  })

  it('登入與註冊按鈕都有至少 44px 的 class', async () => {
    const { default: AuthPage } = await import('./AuthPage')
    const tree = AuthPage()
    for (const label of ['登入', '註冊']) {
      expect(findButton(tree, label)?.props?.className).toContain('min-h-11')
    }
  })

  it('實際切換模式時保留 email、清空密碼與既有錯誤', async () => {
    mocks.stateValues = ['login', 'person@example.com', 'sensitive', '顯示名', '舊錯誤', false]
    const { default: AuthPage } = await import('./AuthPage')
    const tree = AuthPage()

    const button = findButton(tree, '註冊')
    if (!button?.props?.onClick) throw new Error('找不到註冊按鈕')
    ;(button.props.onClick as () => void)()

    expect(mocks.stateSetters[0]).toHaveBeenCalledWith('register')
    expect(mocks.stateSetters[1]).not.toHaveBeenCalled()
    expect(mocks.stateSetters[2]).toHaveBeenCalledWith('')
    expect(mocks.stateSetters[3]).not.toHaveBeenCalled()
    expect(mocks.stateSetters[4]).toHaveBeenCalledWith('')
  })

  it('點已選模式不改任何欄位或錯誤', async () => {
    mocks.stateValues = ['login', 'person@example.com', 'sensitive', '顯示名', '舊錯誤', false]
    const { default: AuthPage } = await import('./AuthPage')
    const tree = AuthPage()

    const button = findButton(tree, '登入')
    if (!button?.props?.onClick) throw new Error('找不到登入按鈕')
    ;(button.props.onClick as () => void)()

    for (const setter of mocks.stateSetters) expect(setter).not.toHaveBeenCalled()
  })
})

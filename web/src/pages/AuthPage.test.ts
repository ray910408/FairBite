import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ navigate: vi.fn() }))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return { ...actual, useState: (initial: unknown) => [initial, vi.fn()] }
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
  beforeEach(() => mocks.navigate.mockReset())

  it('登入與註冊按鈕都有至少 44px 的 class', async () => {
    const { default: AuthPage } = await import('./AuthPage')
    const tree = AuthPage()
    for (const label of ['登入', '註冊']) {
      expect(findButton(tree, label)?.props?.className).toContain('min-h-11')
    }
  })
})

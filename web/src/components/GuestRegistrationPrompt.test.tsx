import { beforeEach, describe, expect, it, vi } from 'vitest'
import { GuestRegistrationPrompt, guestRegistrationDismissKey } from './GuestRegistrationPrompt'

const mocks = vi.hoisted(() => ({ setDismissed: vi.fn() }))
vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useState: (initial: boolean | (() => boolean)) => [typeof initial === 'function' ? initial() : initial, mocks.setDismissed],
  }
})
vi.mock('react-router-dom', () => ({ Link: (props: Record<string, unknown>) => ({ type: 'a', props }) }))

type NodeLike = { type?: unknown; props?: Record<string, unknown> }
function findButton(node: unknown, label: string): NodeLike | undefined {
  if (Array.isArray(node)) return node.map(child => findButton(child, label)).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  const element = node as NodeLike
  const text = typeof element.props?.children === 'string' ? element.props.children : ''
  return element.type === 'button' && text === label ? element : findButton(element.props?.children, label)
}

describe('GuestRegistrationPrompt', () => {
  const values = new Map<string, string>()
  beforeEach(() => {
    values.clear()
    mocks.setDismissed.mockReset()
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    })
    vi.stubGlobal('sessionStorage', { setItem: vi.fn() })
  })

  it('only shows after requested and suppresses repeats for this guest browser session', () => {
    expect(GuestRegistrationPrompt({ userId: 'guest-1', roomId: 'room-1', open: false })).toBeNull()
    const prompt = GuestRegistrationPrompt({ userId: 'guest-1', roomId: 'room-1', open: true })
    const skip = findButton(prompt, '這次先不要')
    expect(skip).toBeDefined()
    ;(skip?.props?.onClick as () => void)()
    expect(localStorage.getItem(guestRegistrationDismissKey('guest-1'))).toBe('1')
    expect(mocks.setDismissed).toHaveBeenCalledWith(true)
    expect(GuestRegistrationPrompt({ userId: 'guest-1', roomId: 'room-1', open: true })).toBeNull()
  })
})

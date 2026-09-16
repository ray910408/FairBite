import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { supabase } from '../lib/supabase'
import { AuthError } from '@supabase/supabase-js'

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  stateIndex: 0,
  stateValues: [] as unknown[],
  stateSetters: [] as ReturnType<typeof vi.fn>[],
  effects: [] as Array<() => void | (() => void)>,
}))

vi.mock('react', async importOriginal => {
  const actual = await importOriginal<typeof import('react')>()
  return {
    ...actual,
    useEffect: (effect: () => void | (() => void)) => { mocks.effects.push(effect) },
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

function findForm(node: unknown): NodeLike | undefined {
  if (Array.isArray(node)) return node.map(findForm).find(Boolean)
  if (!node || typeof node !== 'object') return undefined
  const element = node as NodeLike
  return element.type === 'form' ? element : findForm(element.props?.children)
}

async function submitAuth(mode: 'login' | 'register', email: string) {
  mocks.stateValues = [mode, email, 'password123', '顯示名', '', false]
  const { default: AuthPage } = await import('./AuthPage')
  const form = findForm(AuthPage())
  if (!form?.props?.onSubmit) throw new Error('找不到登入／註冊表單')
  await (form.props.onSubmit as (event: { preventDefault: () => void }) => Promise<void>)({
    preventDefault: vi.fn(),
  })
}

describe('AuthPage segmented control', () => {
  it('bounds the registration name at the database character limit', async () => {
    mocks.stateValues = ['register']
    const { default: AuthPage } = await import('./AuthPage')
    const html = renderToStaticMarkup(AuthPage())
    expect(html).toMatch(/id="displayName"[^>]*maxLength="80"/i)
  })
  beforeEach(() => {
    vi.mocked(supabase.auth.signUp).mockReset().mockResolvedValue({ data: { user: null, session: null }, error: null })
    vi.mocked(supabase.auth.signInWithPassword).mockReset()
    mocks.navigate.mockReset()
    mocks.stateIndex = 0
    mocks.stateValues = []
    mocks.stateSetters = []
    mocks.effects = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
  })

  it.each(['login', 'register'])('進入 %s 頁立即匿名 GET /healthz，離頁時取消請求', async mode => {
    mocks.stateValues = [mode]
    vi.stubEnv('VITE_API_URL', 'https://backend.example.com')
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}'))
    vi.stubGlobal('fetch', fetchMock)
    const { default: AuthPage } = await import('./AuthPage')
    AuthPage()

    expect(mocks.effects).toHaveLength(1)
    const cleanup = mocks.effects[0]()
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://backend.example.com/healthz', {
      method: 'GET', cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal),
    })
    expect(supabase.auth.signUp).not.toHaveBeenCalled()
    expect(supabase.auth.signInWithPassword).not.toHaveBeenCalled()
    const signal = fetchMock.mock.calls[0][1].signal as AbortSignal
    expect(signal.aborted).toBe(false)
    if (typeof cleanup !== 'function') throw new Error('缺少離頁清理')
    cleanup()
    expect(signal.aborted).toBe(true)
  })

  it.each(['pending', 'failed'])('預熱 %s 時仍可送出註冊，未設 API URL 使用本機 proxy', async status => {
    vi.stubEnv('VITE_API_URL', '')
    const fetchMock = vi.fn().mockImplementation(() => status === 'failed'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : new Promise(() => {}))
    vi.stubGlobal('fetch', fetchMock)
    const { default: AuthPage } = await import('./AuthPage')
    AuthPage()
    expect(mocks.effects).toHaveLength(1)
    const cleanup = mocks.effects[0]()
    await Promise.resolve()
    expect(fetchMock.mock.calls[0][0]).toBe('/healthz')
    for (const setter of mocks.stateSetters) expect(setter).not.toHaveBeenCalled()

    mocks.stateIndex = 0
    await submitAuth('register', 'user@example.com')
    expect(supabase.auth.signUp).toHaveBeenCalledOnce()
    expect(mocks.navigate).toHaveBeenCalledWith('/')
    if (typeof cleanup === 'function') cleanup()
  })

  it.each([
    '1@1', '23@d.d', 'a@b', 'abc@gmail', 'abc@localhost', 'abc@', '@gmail.com',
    'abc gmail.com', 'abc@@gmail.com', 'abc@example.', 'abc@example.c', 'abc@.com',
    'abc@example..com', '.abc@gmail.com', 'abc.@gmail.com', 'abc..def@gmail.com', '', '   ',
    '1\\@1', 'person @example.com', 'person@-example.com', 'person@example-.com',
    'user@example.123', `user@example.${'a'.repeat(64)}`, `${'a'.repeat(65)}@gmail.com`,
    `user@${'a'.repeat(64)}.com`,
  ])('註冊拒絕不完整或錯誤的 Email：%s', async email => {
    await submitAuth('register', email)

    expect(supabase.auth.signUp).not.toHaveBeenCalled()
    expect(supabase.auth.signInWithPassword).not.toHaveBeenCalled()
    expect(mocks.stateSetters[4]).toHaveBeenLastCalledWith('請輸入完整的 Email，例如 you@example.com')
    expect(mocks.stateSetters[5]).not.toHaveBeenCalledWith(true)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it.each([
    'user@example.com', 'abc@gmail.com', 'student@ttu.edu.tw', 'test.user+1@gmail.com',
    'a@b.co', 'USER@EXAMPLE.COM', 'user123@sub.example.com', 'abc-def@example.com',
    '23@d.dd', `user@example.${'a'.repeat(63)}`, ' user@example.com ',
  ])('格式正常的 Email 送交 Supabase，由 hook 檢查 MX：%s', async email => {
    await submitAuth('register', email)

    expect(supabase.auth.signUp).toHaveBeenCalledExactlyOnceWith({
      email: email.trim(), password: 'password123', options: { data: { display_name: '顯示名' } },
    })
    expect(mocks.navigate).toHaveBeenCalledWith('/')
  })

  it.each([
    ['signup_email_no_mx', '此 Email 網域沒有可用的收信設定，請確認信箱地址'],
    ['signup_email_dns_unavailable', '暫時無法確認 Email 網域，請稍後再試'],
  ])('hook 拒絕註冊時顯示錯誤且不導頁：%s', async (message, expected) => {
    vi.mocked(supabase.auth.signUp).mockResolvedValue({
      data: { user: null, session: null }, error: new AuthError(message, 422, 'unexpected_failure'),
    })
    await submitAuth('register', 'user@example.com')
    expect(mocks.stateSetters[4]).toHaveBeenLastCalledWith(expected)
    expect(mocks.stateSetters[5]).toHaveBeenLastCalledWith(false)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('註冊連線失敗會顯示錯誤並結束等待', async () => {
    vi.mocked(supabase.auth.signUp).mockRejectedValue(new TypeError('Failed to fetch'))
    await submitAuth('register', 'user@example.com')
    expect(mocks.stateSetters[4]).toHaveBeenLastCalledWith('連線失敗，請檢查網路後再試')
    expect(mocks.stateSetters[5]).toHaveBeenLastCalledWith(false)
    expect(mocks.navigate).not.toHaveBeenCalled()
  })

  it('新註冊規則不阻擋既有帳號登入', async () => {
    vi.mocked(supabase.auth.signInWithPassword).mockResolvedValue({
      data: { user: null, session: null }, error: new AuthError('Invalid login credentials', 400, 'invalid_credentials'),
    })
    await submitAuth('login', '1@1')

    expect(supabase.auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith({ email: '1@1', password: 'password123' })
    expect(supabase.auth.signUp).not.toHaveBeenCalled()
    expect(mocks.stateSetters[4]).toHaveBeenLastCalledWith('Email 或密碼錯誤')
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

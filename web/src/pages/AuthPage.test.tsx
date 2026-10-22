// @vitest-environment jsdom
import { AuthError } from '@supabase/supabase-js'
import { StrictMode } from 'react'
import { act, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { deferred, Landing, settle } from '../test/dom'
import AuthPage from './AuthPage'

// 行為測試：真的 React hooks 跑在 jsdom 上，只在模組邊界 mock——lib/supabase 的 auth 介面，
// 以及全域 fetch（後端預熱、升級前的 Email 檢查、切換帳號前的離房）。
// localStorage／sessionStorage 用 jsdom 的真貨：升級標記（guest-upgrade:<uid>）直接寫進去，
// 就像上一次造訪留下的；斷言也直接讀它，不看頁面內部有幾個 state。

type AuthUser = { id: string; is_anonymous: boolean; email?: string; email_confirmed_at?: string | null }
type Session = { user: AuthUser; access_token?: string } | null

const auth = vi.hoisted(() => ({
  unsubscribe: vi.fn(),
  getUser: vi.fn<() => Promise<{ data: { user: AuthUser | null } }>>(),
  getSession: vi.fn<() => Promise<{ data: { session: Session }; error: Error | null }>>(),
  signUp: vi.fn<(credentials: unknown) => Promise<{ data: { session: unknown }; error: AuthError | null }>>(),
  signInWithPassword: vi.fn<(credentials: unknown) => Promise<{ error: AuthError | null }>>(),
  updateUser: vi.fn<(attributes: unknown, options?: unknown) => Promise<{ error: AuthError | null }>>(),
  onAuthStateChange: vi.fn<(callback: () => void) => unknown>(),
}))

// 載入時網址有沒有驗證信回跳的 ?code=（lib/supabase 在 auth-js 換 code 之前記下的）
const emailCallback = vi.hoisted(() => ({ pending: false, failed: false }))

vi.mock('../lib/supabase', () => ({ supabase: { auth }, emailCallback }))

const fetchMock = vi.fn<(url: string, init?: RequestInit) => Promise<Response>>()

const CONFIRMED_AT = '2026-09-20T00:00:00Z'
const GUEST: AuthUser = { id: 'guest-1', is_anonymous: true }
// 訪客升級中：匿名旗標已清掉、帶著 email，email_confirmed_at 決定驗證完了沒
const upgrading = (email: string, confirmedAt: string | null): AuthUser =>
  ({ id: 'guest-up', is_anonymous: false, email, email_confirmed_at: confirmedAt })
const marker = (user: AuthUser, email: string) => localStorage.setItem(`guest-upgrade:${user.id}`, email)
const signedIn = (user: AuthUser) =>
  auth.getSession.mockResolvedValue({ data: { session: { user, access_token: 'guest-token' } }, error: null })
const currentUser = (user: AuthUser) => auth.getUser.mockResolvedValue({ data: { user } })
const invalidCredentials = () => new AuthError('Invalid login credentials', 400, 'invalid_credentials')

async function renderAuth(path = '/auth') {
  const view = render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="*" element={<Landing />} />
      </Routes>
    </MemoryRouter>,
  )
  await settle()
  return view
}

// 登入／註冊兩顆分段鈕帶 aria-pressed；登入模式的送出鈕也叫「登入」，靠這個分開
const tab = (name: '登入' | '註冊') =>
  screen.getAllByRole('button', { name }).find(button => button.hasAttribute('aria-pressed'))!
const form = () => document.querySelector('form')!
const submitButton = () => within(form()).getByRole<HTMLButtonElement>('button')
const field = (label: string) => screen.getByLabelText<HTMLInputElement>(label)
const fill = (label: string, value: string) => fireEvent.change(field(label), { target: { value } })
const landed = () => screen.queryByText(/^到了 /)?.textContent ?? null
const dialog = () => screen.getByRole('dialog')
const alertText = () => screen.getByRole('alert').textContent
const statusText = () => screen.getByRole('status').textContent

// 瀏覽器的 type=email 只擋最粗的格式（a@b 會過），送出前還有頁面自己的格式檢查：
// 直接 submit 表單，測的就是那一層
async function submit() {
  fireEvent.submit(form())
  await settle()
}

function fillRegistration(email: string) {
  fill('顯示名稱', '顯示名')
  fill('Email', email)
  fill('密碼', 'password123')
}

function fillLogin(email: string) {
  fill('Email', email)
  fill('密碼', 'password123')
}

beforeEach(() => {
  vi.resetAllMocks()
  // 不吃開發機的 .env：未設 API URL 一律走本機 proxy（相對路徑）
  vi.stubEnv('VITE_API_URL', '')
  auth.getUser.mockResolvedValue({ data: { user: null } })
  auth.getSession.mockResolvedValue({ data: { session: null }, error: null })
  auth.signUp.mockResolvedValue({ data: { session: null }, error: null })
  auth.signInWithPassword.mockResolvedValue({ error: null })
  auth.updateUser.mockResolvedValue({ error: null })
  auth.onAuthStateChange.mockReturnValue({ data: { subscription: { unsubscribe: auth.unsubscribe } } })
  emailCallback.pending = false
  emailCallback.failed = false
  fetchMock.mockImplementation(async () => new Response('{}'))
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllEnvs()
  sessionStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('登入／註冊分段控制', () => {
  it('預設登入；註冊提示連結（?mode=register）直接開啟註冊模式', async () => {
    const view = await renderAuth()
    expect(tab('登入').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText('顯示名稱')).toBeNull()
    expect(submitButton().textContent).toBe('登入')
    view.unmount()

    await renderAuth('/auth?mode=register')
    expect(tab('註冊').getAttribute('aria-pressed')).toBe('true')
    expect(tab('登入').getAttribute('aria-pressed')).toBe('false')
    expect(field('顯示名稱')).toBeTruthy()
    expect(submitButton().textContent).toBe('建立帳號')
  })

  it('註冊的顯示名稱以資料庫字數上限為界', async () => {
    await renderAuth('/auth?mode=register')
    expect(field('顯示名稱').maxLength).toBe(80)
  })

  it('新密碼至少 8 碼；登入維持 6 碼，舊規則註冊的帳號仍登得進來', async () => {
    await renderAuth()
    expect(field('密碼').minLength).toBe(6)
    fireEvent.click(tab('註冊'))
    expect(field('密碼').minLength).toBe(8)
    expect(field('密碼').placeholder).toBe('至少 8 碼')
  })

  it('登入與註冊按鈕都有至少 44px 的 class', async () => {
    await renderAuth()
    for (const name of ['登入', '註冊'] as const) expect(tab(name).className).toContain('min-h-11')
  })

  it('實際切換模式時保留 Email 與顯示名稱、清空密碼與既有錯誤', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: invalidCredentials() })
    await renderAuth('/auth?mode=register')
    fill('顯示名稱', '顯示名')
    fill('Email', 'person@example.com')
    fill('密碼', 'sensitive')

    fireEvent.click(tab('登入'))
    expect(tab('登入').getAttribute('aria-pressed')).toBe('true')
    expect(field('Email').value).toBe('person@example.com')
    expect(field('密碼').value).toBe('')

    fill('密碼', 'sensitive')
    await submit()
    expect(alertText()).toBe('Email 或密碼錯誤')

    fireEvent.click(tab('註冊'))
    expect(tab('註冊').getAttribute('aria-pressed')).toBe('true')
    expect(field('顯示名稱').value).toBe('顯示名')
    expect(field('Email').value).toBe('person@example.com')
    expect(field('密碼').value).toBe('')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('點已選模式不改任何欄位或錯誤', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: invalidCredentials() })
    await renderAuth()
    fill('Email', 'person@example.com')
    fill('密碼', 'sensitive')
    await submit()
    expect(alertText()).toBe('Email 或密碼錯誤')

    fireEvent.click(tab('登入'))
    expect(tab('登入').getAttribute('aria-pressed')).toBe('true')
    expect(field('Email').value).toBe('person@example.com')
    expect(field('密碼').value).toBe('sensitive')
    expect(alertText()).toBe('Email 或密碼錯誤')
  })
})

// PKCE：驗證信回跳帶 ?code=，auth-js 在本機有 code_verifier 時換成 session 並移除 code；
// 頁面等 getSession（初始化完成）後分辨三種落地
describe('驗證信回跳', () => {
  const NOTICE = 'Email 已完成驗證。請用 Email 與密碼登入；若是訪客升級，請回到寄出驗證信的裝置設定密碼。'

  // StrictMode 的第一輪 effect 會被清掉；旗標不能在第一輪就被吃掉，否則第二輪什麼都不做
  it('別的裝置點信（code 沒被換掉）：提示回原裝置或直接登入，清掉網址的 code，不導頁', async () => {
    window.history.replaceState(null, '', '/app/?ref=qr&code=abc#/auth')
    emailCallback.pending = true
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/auth']}>
          <Routes>
            <Route path="/auth" element={<AuthPage />} />
            <Route path="*" element={<Landing />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    )
    await settle()

    expect(statusText()).toBe(NOTICE)
    expect(window.location.search).toBe('?ref=qr')
    expect(window.location.hash).toBe('#/auth')
    expect(landed()).toBeNull()
    expect(emailCallback.pending).toBe(false)
  })

  // 同瀏覽器的訪客升級超過 5 分鐘才點信：flow state 過期、code 沒換掉，但訪客 session 還在
  it('code 沒換掉但手上有 session：不叫人回原裝置，留給升級流程接續', async () => {
    window.history.replaceState(null, '', '/app/?code=abc#/auth')
    emailCallback.pending = true
    const confirmed = upgrading('guest@gmail.com', CONFIRMED_AT)
    marker(confirmed, 'guest@gmail.com')
    currentUser(confirmed)
    signedIn(confirmed)
    await renderAuth()
    expect(document.body.textContent).not.toContain(NOTICE)
    expect(window.location.search).toBe('')
    expect(submitButton().textContent).toBe('完成註冊')
  })

  // StrictMode 第一輪 effect 就消耗旗標：第二輪不再設，但第一輪設的提示要留著
  it('驗證連結失效（GoTrue 帶 ?error=）：提示重寄或直接登入', async () => {
    emailCallback.failed = true
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/auth']}>
          <Routes>
            <Route path="/auth" element={<AuthPage />} />
            <Route path="*" element={<Landing />} />
          </Routes>
        </MemoryRouter>
      </StrictMode>,
    )
    await settle()
    expect(statusText()).toBe('驗證連結已失效或已使用過。請重新寄送驗證信，或直接用 Email 與密碼登入。')
    expect(emailCallback.failed).toBe(false)
  })

  it('同一個瀏覽器點註冊確認信（code 已換成 session）：直接進首頁', async () => {
    emailCallback.pending = true
    signedIn({ id: 'new-user', is_anonymous: false, email: 'new@gmail.com', email_confirmed_at: CONFIRMED_AT })
    await renderAuth()
    expect(landed()).toBe('到了 /（REPLACE）')
  })

  it('訪客升級的確認信回跳：留在本頁設定密碼，不進首頁', async () => {
    emailCallback.pending = true
    const confirmed = upgrading('guest@gmail.com', CONFIRMED_AT)
    marker(confirmed, 'guest@gmail.com')
    currentUser(confirmed)
    signedIn(confirmed)
    await renderAuth()
    expect(landed()).toBeNull()
    expect(submitButton().textContent).toBe('完成註冊')
  })

  it('不是從信件回跳就不查 session、不導頁', async () => {
    signedIn({ id: 'member', is_anonymous: false })
    await renderAuth()
    expect(auth.getSession).not.toHaveBeenCalled()
    expect(landed()).toBeNull()
  })
})

describe('後端預熱', () => {
  it.each(['/auth', '/auth?mode=register'])('進入 %s 立即匿名 GET /healthz，離頁時取消請求並退訂', async path => {
    vi.stubEnv('VITE_API_URL', 'https://backend.example.com')
    const view = await renderAuth(path)
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith('https://backend.example.com/healthz', {
      method: 'GET', cache: 'no-store', credentials: 'omit', signal: expect.any(AbortSignal),
    })
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
    const signal = fetchMock.mock.calls[0][1]!.signal!
    expect(signal.aborted).toBe(false)
    expect(auth.unsubscribe).not.toHaveBeenCalled()

    view.unmount()
    expect(signal.aborted).toBe(true)
    expect(auth.unsubscribe).toHaveBeenCalledOnce()
  })

  it.each(['pending', 'failed'])('預熱 %s 時仍可送出註冊，未設 API URL 走本機 proxy', async status => {
    fetchMock.mockImplementation(() => status === 'failed'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : new Promise(() => {}))
    await renderAuth('/auth?mode=register')
    expect(fetchMock.mock.calls[0][0]).toBe('/healthz')
    // 預熱的結果不碰畫面：沒有錯誤、模式不變、送出鈕可按
    expect(screen.queryByRole('alert')).toBeNull()
    expect(tab('註冊').getAttribute('aria-pressed')).toBe('true')
    expect(submitButton().disabled).toBe(false)

    fillRegistration('user@example.com')
    await submit()
    expect(auth.signUp).toHaveBeenCalledOnce()
    expect(statusText()).toBe('驗證信已寄出。請完成 Email 驗證後回來登入。')
    expect(landed()).toBeNull()
  })
})

// 不收前後帶空白的測資：type=email 的值在瀏覽器（jsdom 也一樣）就先去掉頭尾空白，頁面讀到的已經
// 是乾淨的值，AuthPage 的 email.trim() 從畫面上走不到，放了也只是假裝有測
describe('註冊 Email 格式', () => {
  it.each([
    '1@1', '23@d.d', 'a@b', 'abc@gmail', 'abc@localhost', 'abc@', '@gmail.com',
    'abc gmail.com', 'abc@@gmail.com', 'abc@example.', 'abc@example.c', 'abc@.com',
    'abc@example..com', '.abc@gmail.com', 'abc.@gmail.com', 'abc..def@gmail.com', '',
    '1\\@1', 'person @example.com', 'person@-example.com', 'person@example-.com',
    'user@example.123', `user@example.${'a'.repeat(64)}`, `${'a'.repeat(65)}@gmail.com`,
    `user@${'a'.repeat(64)}.com`,
    // 每段都合規、總長 260：只有 254 字上限擋得到
    `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(63)}.com`,
  ])('註冊拒絕不完整或錯誤的 Email：%s', async email => {
    await renderAuth('/auth?mode=register')
    fillRegistration(email)
    await submit()

    expect(auth.getSession).not.toHaveBeenCalled() // 格式不對連 session 都不查
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
    expect(alertText()).toBe('請輸入完整的 Email，例如 you@example.com')
    expect(submitButton().disabled).toBe(false)
    expect(landed()).toBeNull()
  })

  // 驗證信要連回目前這份部署（GitHub Pages 子路徑＋查詢字串），再用 hash route 開登入頁
  it.each([
    'user@example.com', 'abc@gmail.com', 'student@ttu.edu.tw', 'test.user+1@gmail.com',
    'a@b.co', 'USER@EXAMPLE.COM', 'user123@sub.example.com', 'abc-def@example.com',
    '23@d.dd', `user@example.${'a'.repeat(63)}`,
    // 上限本身要放行：local part 剛好 64、總長剛好 254
    `${'a'.repeat(64)}@gmail.com`, `${'a'.repeat(64)}@${'b'.repeat(63)}.${'c'.repeat(63)}.${'d'.repeat(57)}.com`,
  ])('格式正常的 Email 送交 Supabase，由 hook 檢查 MX：%s', async email => {
    window.history.replaceState(null, '', '/app/?ref=qr')
    await renderAuth('/auth?mode=register')
    fillRegistration(email)
    await submit()

    expect(auth.signUp).toHaveBeenCalledExactlyOnceWith({
      email, password: 'password123', options: {
        data: { display_name: '顯示名' }, emailRedirectTo: `${window.location.origin}/app/?ref=qr#/auth`,
      },
    })
    expect(statusText()).toBe('驗證信已寄出。請完成 Email 驗證後回來登入。')
    expect(screen.queryByRole('alert')).toBeNull()
    expect(landed()).toBeNull()
  })

  it.each([
    ['signup_email_no_mx', '此 Email 網域沒有可用的收信設定，請確認信箱地址'],
    ['signup_email_dns_unavailable', '暫時無法確認 Email 網域，請稍後再試'],
  ])('hook 拒絕註冊時顯示錯誤且不導頁：%s', async (message, expected) => {
    auth.signUp.mockResolvedValue({ data: { session: null }, error: new AuthError(message, 422, 'unexpected_failure') })
    await renderAuth('/auth?mode=register')
    fillRegistration('user@example.com')
    await submit()
    expect(alertText()).toBe(expected)
    expect(screen.queryByRole('status')).toBeNull()
    expect(submitButton().disabled).toBe(false)
    expect(landed()).toBeNull()
  })

  it('註冊連線失敗會顯示錯誤並結束等待', async () => {
    const signUp = deferred<never>()
    auth.signUp.mockReturnValue(signUp.promise)
    await renderAuth('/auth?mode=register')
    fillRegistration('user@example.com')
    await submit()
    expect(submitButton().disabled).toBe(true)

    await act(async () => signUp.reject(new TypeError('Failed to fetch')))
    await settle()
    expect(alertText()).toBe('連線失敗，請檢查網路後再試')
    expect(submitButton().disabled).toBe(false)
    expect(landed()).toBeNull()
  })

  it('新註冊規則不阻擋既有帳號登入', async () => {
    auth.signInWithPassword.mockResolvedValue({ error: invalidCredentials() })
    await renderAuth()
    fillLogin('1@1')
    await submit()

    expect(auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith({ email: '1@1', password: 'password123' })
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(alertText()).toBe('Email 或密碼錯誤')
  })

  // 註冊若專案關掉了 Email 驗證，signUp 直接帶回 session，等同登入
  it.each(['/auth', '/auth?mode=register'])('%s 成功拿到 session 就回首頁', async path => {
    auth.signUp.mockResolvedValue({ data: { session: { access_token: 'new' } }, error: null })
    await renderAuth(path)
    if (path === '/auth') fillLogin('member@example.com')
    else fillRegistration('member@example.com')
    await submit()
    expect(landed()).toBe('到了 /（PUSH）')
  })
})

// 訪客（匿名或升級到一半）改登既有帳號＝換一個身分：房籍不會跟過去，必須先確認離房
describe('訪客登入既有帳號', () => {
  it('訪客每次提交既有帳號登入都只開離房確認，不會第二次繞過', async () => {
    currentUser(GUEST)
    signedIn(GUEST)
    await renderAuth()
    fillLogin('member@example.com')
    await submit()
    expect(within(dialog()).getByRole('heading', { name: '切換到既有帳號？' })).toBeTruthy()

    fireEvent.click(within(dialog()).getByRole('button', { name: '取消' }))
    expect(screen.queryByRole('dialog')).toBeNull()
    await submit()
    expect(dialog()).toBeTruthy()
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalledWith('/api/leave', expect.anything())
  })

  it('離房確認開著時背景 inert；Esc 也能關，關掉後背景恢復', async () => {
    currentUser(GUEST)
    signedIn(GUEST)
    await renderAuth()
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false)
    fillLogin('member@example.com')
    await submit()
    const cancel = within(dialog()).getByRole('button', { name: '取消' })
    expect(document.activeElement).toBe(cancel) // 預設落在不會離房的那顆
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(true)
    expect(screen.getByRole('main').contains(dialog())).toBe(false)

    fireEvent.keyDown(cancel, { key: 'Escape' })
    expect(screen.queryByRole('dialog')).toBeNull()
    expect(screen.getByRole('main').hasAttribute('inert')).toBe(false)
  })

  it('初始 getUser 尚未完成時，匿名 session 登入仍只開離房確認', async () => {
    auth.getUser.mockReturnValue(new Promise(() => {}))
    signedIn({ id: 'guest-pending', is_anonymous: true })
    await renderAuth()
    fillLogin('member@example.com')
    await submit()

    expect(dialog()).toBeTruthy()
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
  })

  it('升級尚未完成時登入既有帳號仍需離房確認', async () => {
    const pending = upgrading('guest@gmail.com', null)
    marker(pending, 'guest@gmail.com')
    currentUser(pending)
    signedIn(pending)
    await renderAuth()
    fireEvent.click(tab('登入')) // 重載時被帶到升級頁，自己切回登入
    fillLogin('member@example.com')
    await submit()

    expect(dialog()).toBeTruthy()
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
  })

  // 離房走 leaveRooms()（60 秒逾時）：HTTP 失敗、斷線、逾時都講同一句，明說身分沒換
  it.each([
    ['leave-http', '離開目前房間失敗，仍保留訪客身分；請稍後再試'],
    ['leave-network', '離開目前房間失敗，仍保留訪客身分；請稍後再試'],
    ['login-credentials', 'Email 或密碼錯誤'],
    ['login-network', '連線失敗，請檢查網路後再試'],
  ])('切換帳號失敗 %s 在仍開著的確認框裡顯示錯誤', async (failure, message) => {
    currentUser(GUEST)
    signedIn(GUEST)
    fetchMock.mockImplementation(async url => {
      if (url !== '/api/leave') return new Response('{}')
      if (failure === 'leave-network') throw new TypeError('Failed to fetch')
      return new Response('{}', { status: failure === 'leave-http' ? 500 : 200 })
    })
    auth.signInWithPassword.mockResolvedValue({ error: invalidCredentials() })
    if (failure === 'login-network') auth.signInWithPassword.mockRejectedValue(new TypeError('Failed to fetch'))
    await renderAuth()
    fillLogin('member@example.com')
    await submit()
    fireEvent.click(within(dialog()).getByRole('button', { name: '離房並登入' }))
    await settle()

    expect(fetchMock).toHaveBeenCalledWith('/api/leave', {
      method: 'POST', headers: { Authorization: 'Bearer guest-token' }, signal: expect.any(AbortSignal),
    })
    expect(within(dialog()).getByRole('alert').textContent).toBe(message)
    expect(screen.getAllByRole('alert')).toHaveLength(1) // 表單那邊被蓋住，不重複顯示
    expect(within(dialog()).getByRole<HTMLButtonElement>('button', { name: '離房並登入' }).disabled).toBe(false)
    expect(landed()).toBeNull()
    if (failure.startsWith('leave-')) expect(auth.signInWithPassword).not.toHaveBeenCalled()
    else expect(auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith({ email: 'member@example.com', password: 'password123' })
  })

  it('完成 Email 驗證的升級流程切回登入時可輸入既有帳號 Email', async () => {
    const upgraded = upgrading('guest@gmail.com', CONFIRMED_AT)
    marker(upgraded, 'guest@gmail.com')
    currentUser(upgraded)
    signedIn(upgraded)
    await renderAuth()
    expect(submitButton().textContent).toBe('完成註冊')
    expect(screen.queryByLabelText('Email')).toBeNull()

    fireEvent.click(tab('登入'))
    fillLogin('member@example.com')
    await submit()
    const leave = deferred<Response>()
    fetchMock.mockImplementation(async url => url === '/api/leave' ? leave.promise : new Response('{}'))
    const confirm = within(dialog()).getByRole<HTMLButtonElement>('button', { name: '離房並登入' })
    fireEvent.click(confirm)
    await settle()
    expect(confirm.disabled).toBe(true) // 離房途中不能再送第二次
    await act(async () => leave.resolve(new Response('{}')))
    await settle()

    expect(fetchMock).toHaveBeenCalledWith('/api/leave', {
      method: 'POST', headers: { Authorization: 'Bearer guest-token' }, signal: expect.any(AbortSignal),
    })
    expect(auth.signInWithPassword).toHaveBeenCalledExactlyOnceWith({ email: 'member@example.com', password: 'password123' })
    expect(auth.updateUser).not.toHaveBeenCalled()
    expect(landed()).toBe('到了 /（PUSH）')
  })
})

// 訪客升級：先改 Email、等驗證，驗證完回來才設密碼；中途重載要能接回去
describe('訪客升級成正式帳號', () => {
  it('初始 getUser 尚未完成時，匿名 session 註冊走驗證升級而非 signUp', async () => {
    auth.getUser.mockReturnValue(new Promise(() => {}))
    signedIn({ id: 'guest-pending', is_anonymous: true })
    window.history.replaceState(null, '', '/app/?ref=qr')
    await renderAuth('/auth?mode=register')
    fillRegistration('guest@gmail.com')
    await submit()

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/validate-upgrade-email', {
      method: 'POST',
      headers: { Authorization: 'Bearer guest-token', 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'guest@gmail.com' }),
      signal: expect.any(AbortSignal), // 有逾時：Render 冷啟動時不會永遠轉圈
    })
    expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith(
      { email: 'guest@gmail.com' }, { emailRedirectTo: `${window.location.origin}/app/?ref=qr#/auth` },
    )
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(statusText()).toBe('驗證信已寄出。請先完成 Email 驗證，再回來設定密碼；目前訪客房籍與紀錄都會保留。')
    expect(landed()).toBeNull()
  })

  it('後端升級檢查拒絕時顯示原因，不改 Email、不留標記', async () => {
    currentUser(GUEST)
    signedIn(GUEST)
    fetchMock.mockImplementation(async url => url === '/api/auth/validate-upgrade-email'
      ? new Response(JSON.stringify({ error: 'signup_email_no_mx' }), { status: 422 })
      : new Response('{}'))
    await renderAuth('/auth?mode=register')
    fill('Email', 'guest@nomx.example')
    await submit()

    expect(alertText()).toBe('此 Email 網域沒有可用的收信設定，請確認信箱地址')
    expect(auth.updateUser).not.toHaveBeenCalled()
    expect(localStorage.getItem('guest-upgrade:guest-1')).toBeNull()
    expect(submitButton().disabled).toBe(false)
  })

  it.each(['升級寄信', '切換帳號'])('session 沒有 token 就不打後端（%s）', async flow => {
    currentUser(GUEST)
    auth.getSession.mockResolvedValue({ data: { session: { user: GUEST } }, error: null })
    if (flow === '升級寄信') {
      await renderAuth('/auth?mode=register')
      fill('Email', 'guest@gmail.com')
      await submit()
    } else {
      await renderAuth()
      fillLogin('member@example.com')
      await submit()
      fireEvent.click(within(dialog()).getByRole('button', { name: '離房並登入' }))
      await settle()
    }
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual(['/healthz'])
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(auth.updateUser).not.toHaveBeenCalled()
    expect(auth.signInWithPassword).not.toHaveBeenCalled()
  })

  // 在別的分頁點了驗證信：Supabase 推來 auth 事件，這頁要重抓使用者，直接換成設定密碼
  it('auth 狀態變了就重抓使用者：驗證完成後換成設定密碼', async () => {
    const pending = upgrading('guest@gmail.com', null)
    marker(pending, 'guest@gmail.com')
    currentUser(pending)
    await renderAuth()
    expect(submitButton().textContent).toBe('寄送驗證信')

    currentUser(upgrading('guest@gmail.com', CONFIRMED_AT))
    const [onChange] = auth.onAuthStateChange.mock.calls[0]
    await act(async () => onChange())
    await settle()
    expect(submitButton().textContent).toBe('完成註冊')
  })

  // main.tsx 包了 StrictMode：開發模式 effect 跑兩次，第一輪的 getUser 晚到不能蓋掉第二輪的結果
  it('StrictMode 第一輪的 getUser 晚到不套用，不會被舊結果帶進升級', async () => {
    const stale = deferred<{ data: { user: AuthUser | null } }>()
    const fresh = deferred<{ data: { user: AuthUser | null } }>()
    auth.getUser.mockReturnValueOnce(stale.promise).mockReturnValueOnce(fresh.promise)
    const pending = upgrading('guest@gmail.com', null)
    marker(pending, 'guest@gmail.com')
    render(
      <StrictMode>
        <MemoryRouter initialEntries={['/auth']}>
          <Routes><Route path="/auth" element={<AuthPage />} /></Routes>
        </MemoryRouter>
      </StrictMode>,
    )
    expect(auth.getUser).toHaveBeenCalledTimes(2)
    await act(async () => fresh.resolve({ data: { user: null } }))
    await act(async () => stale.resolve({ data: { user: pending } }))
    expect(tab('登入').getAttribute('aria-pressed')).toBe('true')
    expect(submitButton().textContent).toBe('登入')
  })

  it.each([
    ['guest@gmail.com', null, false],
    ['other@gmail.com', CONFIRMED_AT, false],
    ['guest@gmail.com', CONFIRMED_AT, true],
  ] as const)('重載升級頁只在對應 Email 已驗證時顯示設密碼：%s / %s', async (email, confirmedAt, canResume) => {
    const user = upgrading(email, confirmedAt)
    marker(user, 'guest@gmail.com')
    currentUser(user)
    await renderAuth() // 從登入頁進來也會被帶到升級
    expect(tab('註冊').getAttribute('aria-pressed')).toBe('true')
    expect(screen.queryByLabelText('顯示名稱')).toBeNull()
    if (canResume) {
      expect(submitButton().textContent).toBe('完成註冊')
      expect(screen.queryByLabelText('Email')).toBeNull()
      expect(field('密碼')).toBeTruthy()
    } else {
      expect(submitButton().textContent).toBe('寄送驗證信')
      expect(field('Email').value).toBe('guest@gmail.com')
      expect(screen.queryByLabelText('密碼')).toBeNull()
    }
    // Email 帶入的是標記裡那個地址（不是 session 上的）：設密碼畫面藏起來了，切回登入看得到
    fireEvent.click(tab('登入'))
    expect(field('Email').value).toBe('guest@gmail.com')
  })

  it('匿名旗標已清除仍可更正待驗證 Email，保留同一身分', async () => {
    const pending: AuthUser = { id: 'guest-pending', is_anonymous: false, email_confirmed_at: null }
    marker(pending, 'wrong@gmail.com')
    currentUser(pending)
    signedIn(pending)
    await renderAuth()
    expect(field('Email').value).toBe('wrong@gmail.com')
    fill('Email', 'corrected@gmail.com')
    await submit()

    expect(fetchMock).toHaveBeenCalledWith('/api/auth/validate-upgrade-email', expect.objectContaining({
      body: JSON.stringify({ email: 'corrected@gmail.com' }),
      headers: expect.objectContaining({ Authorization: 'Bearer guest-token' }),
    }))
    expect(auth.updateUser).toHaveBeenCalledWith(
      { email: 'corrected@gmail.com' }, { emailRedirectTo: `${window.location.origin}/#/auth` },
    )
    expect(localStorage.getItem('guest-upgrade:guest-pending')).toBe('corrected@gmail.com')
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(landed()).toBeNull()
  })

  // 回應在路上遺失（請求其實成功了）：標記要在送出前就寫好，重載才接得回驗證流程
  it('遠端升級回應遺失前已保留更正後 Email 以供恢復', async () => {
    const guest: AuthUser = { id: 'guest-interrupted', is_anonymous: true }
    currentUser(guest)
    signedIn(guest)
    let markerAtRequest: string | null = null
    auth.updateUser.mockImplementation(async () => {
      markerAtRequest = localStorage.getItem('guest-upgrade:guest-interrupted')
      throw new TypeError('Failed to fetch')
    })
    await renderAuth('/auth?mode=register')
    expect(submitButton().textContent).toBe('寄送驗證信')
    fill('Email', 'Corrected@Gmail.com')
    await submit()

    expect(auth.updateUser).toHaveBeenCalledOnce()
    expect(markerAtRequest).toBe('corrected@gmail.com')
    expect(localStorage.getItem('guest-upgrade:guest-interrupted')).toBe('corrected@gmail.com')
    expect(alertText()).toBe('連線失敗，請檢查網路後再試')
  })

  it('無法保留升級 Email 時不開始遠端更新', async () => {
    const guest: AuthUser = { id: 'guest-storage-failed', is_anonymous: true }
    currentUser(guest)
    signedIn(guest)
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new DOMException('Quota exceeded', 'QuotaExceededError')
    })
    await renderAuth('/auth?mode=register')
    fill('Email', 'guest@gmail.com')
    await submit()

    expect(auth.updateUser).not.toHaveBeenCalled()
    expect(screen.getByRole('alert')).toBeTruthy()
    expect(submitButton().disabled).toBe(false)
  })

  // 頁面載入時看到的是已驗證；送出當下 session 上的 Email 卻還沒驗證（例如在別處又改了一次）
  it('resume 送出時重新確認 session，未驗證 Email 不可設定密碼', async () => {
    const confirmed = upgrading('guest@gmail.com', CONFIRMED_AT)
    marker(confirmed, 'guest@gmail.com')
    currentUser(confirmed)
    signedIn({ ...confirmed, email_confirmed_at: null })
    await renderAuth()
    expect(submitButton().textContent).toBe('完成註冊')
    fill('密碼', 'password123')
    await submit()

    expect(auth.updateUser).not.toHaveBeenCalled()
    expect(statusText()).toBe('請先完成 Email 驗證，再回來設定密碼。')
    expect(localStorage.getItem('guest-upgrade:guest-up')).toBe('guest@gmail.com')
    expect(landed()).toBeNull()
    expect(submitButton().textContent).toBe('寄送驗證信') // 退回等驗證，不再給設密碼
  })

  it('resume 送出只接受 marker 對應的已驗證 Email：設密碼、清標記、取代掉登入頁回到升級前那頁', async () => {
    const confirmed = upgrading('guest@gmail.com', CONFIRMED_AT)
    marker(confirmed, 'guest@gmail.com')
    sessionStorage.setItem('guest-upgrade-return:guest-up', '/room/r1')
    currentUser(confirmed)
    signedIn(confirmed)
    await renderAuth()
    fill('密碼', 'password123')
    await submit()

    expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({ password: 'password123' })
    expect(localStorage.getItem('guest-upgrade:guest-up')).toBeNull()
    expect(sessionStorage.getItem('guest-upgrade-return:guest-up')).toBeNull()
    expect(landed()).toBe('到了 /room/r1（REPLACE）')
  })

  it.each(['pending', 'rejected'])('初始 getUser %s 時，已驗證 session 直接完成升級而非重新 signUp', async status => {
    const confirmed = upgrading('guest@gmail.com', CONFIRMED_AT)
    marker(confirmed, 'guest@gmail.com')
    auth.getUser.mockImplementation(() => status === 'rejected'
      ? Promise.reject(new TypeError('Failed to fetch'))
      : new Promise(() => {}))
    signedIn(confirmed)
    await renderAuth('/auth?mode=register')
    expect(submitButton().textContent).toBe('建立帳號') // 畫面還不知道這是升級中的身分
    fillRegistration('guest@gmail.com')
    await submit()

    expect(auth.updateUser).toHaveBeenCalledExactlyOnceWith({ password: 'password123' })
    expect(auth.signUp).not.toHaveBeenCalled()
    expect(localStorage.getItem('guest-upgrade:guest-up')).toBeNull()
    expect(landed()).toBe('到了 /（REPLACE）')
  })
})

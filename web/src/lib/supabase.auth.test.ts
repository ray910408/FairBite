// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// 用真的 supabase-js client（只 stub 全域 fetch）：模組載入時 auth-js 就會讀網址，
// 每個測試先擺好網址再重新 import
const b64 = (value: object) => btoa(JSON.stringify(value)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')

beforeEach(() => {
  vi.resetModules()
  vi.stubEnv('VITE_SUPABASE_URL', 'http://127.0.0.1:54321')
  vi.stubEnv('VITE_SUPABASE_ANON_KEY', 'anon-key')
})

afterEach(() => {
  vi.unstubAllEnvs()
  vi.unstubAllGlobals()
  localStorage.clear()
  window.history.replaceState(null, '', '/')
})

describe('supabase client', () => {
  // login CSRF：implicit flow 會把網址上的 token 直接存成 session，攻擊者的連結能把受害者換成攻擊者
  it('網址帶別人的 #access_token 也不會變成 session', async () => {
    const exp = Math.floor(Date.now() / 1000) + 3600
    const token = `${b64({ alg: 'HS256', typ: 'JWT' })}.${b64({ sub: 'attacker', exp, role: 'authenticated', is_anonymous: true })}.sig`
    const fetchMock = vi.fn(async () => Response.json({ id: 'attacker', aud: 'authenticated', role: 'authenticated', is_anonymous: true }))
    vi.stubGlobal('fetch', fetchMock)
    window.history.replaceState(null, '', `/#access_token=${token}&refresh_token=attacker-refresh&expires_in=3600&expires_at=${exp}&token_type=bearer&type=magiclink`)

    const { supabase } = await import('./supabase')
    const { data } = await supabase.auth.getSession()

    expect(data.session).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled() // 連拿 token 去查使用者都沒有
  })

  it('載入時網址帶 ?code= 就記下來，給 AuthPage 分辨驗證信回跳', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
    window.history.replaceState(null, '', '/?code=abc#/auth')
    const { emailCallback } = await import('./supabase')
    expect(emailCallback.pending).toBe(true)
  })

  it('一般網址不算驗證信回跳', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
    window.history.replaceState(null, '', '/?ref=qr#/join/ABCDEF123456')
    const { emailCallback } = await import('./supabase')
    expect(emailCallback).toEqual({ pending: false, failed: false })
    expect(window.location.search).toBe('?ref=qr')
  })

  // 留著的 error 會被重寄信的 emailRedirectTo 與邀請連結帶走，新連結因此換不到 session
  // GoTrue v2.195 實測的失效回跳形狀：query 帶 error，fragment 整段換成 #error=…，#/auth 不見
  it('驗證連結失效：auth-js 讀網址前清掉 error 參數、路由放回 #/auth，其他參數保留', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
    window.history.replaceState(null, '', '/?ref=qr&error=access_denied#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid&sb=')
    const { emailCallback } = await import('./supabase')
    expect(emailCallback.failed).toBe(true)
    expect(window.location.search).toBe('?ref=qr')
    expect(window.location.hash).toBe('#/auth')
  })

  it('部署前寄出的 implicit 信失效時只帶 fragment，也一樣處理', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => Response.json({})))
    window.history.replaceState(null, '', '/#error=access_denied&error_code=otp_expired&error_description=Email+link+is+invalid')
    const { emailCallback } = await import('./supabase')
    expect(emailCallback.failed).toBe(true)
    expect(window.location.hash).toBe('#/auth')
  })

  it('登出時清掉出發點座標（共用裝置不留上一個人的位置），其他偏好留著', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 204 })))
    const point = JSON.stringify({ lat: 25, lng: 121.5, label: '台北車站' })
    localStorage.setItem('last-departure:u1', point)
    localStorage.setItem('room-departure:r1', point)
    localStorage.setItem('theme', 'dark')

    const { supabase } = await import('./supabase')
    await supabase.auth.signOut()

    expect(localStorage.getItem('last-departure:u1')).toBeNull()
    expect(localStorage.getItem('room-departure:r1')).toBeNull()
    expect(localStorage.getItem('theme')).toBe('dark')
  })
})

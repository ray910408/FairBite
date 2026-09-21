import { useEffect, useState } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import type { User } from '@supabase/supabase-js'
import { authErrorMessage } from '../lib/authErrors'
import { supabase } from '../lib/supabase'
import { Alert, Logo, Spinner } from '../components/icons'
import { LeaveConfirm } from '../components/LeaveConfirm'

// Same format policy as server/signup_email.go; DNS MX is enforced by the Supabase hook.
const registrationEmailPattern = /^[a-z0-9!#$%&'*+/=?^_`{|}~-]+(?:\.[a-z0-9!#$%&'*+/=?^_`{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\.[a-z]{2,63}$/i

function guestUpgradeState(user: User, marker: string | null) {
  const pending = !user.is_anonymous && !!marker
  const confirmed = pending && !!user.email_confirmed_at && user.email?.toLowerCase() === marker
  return { pending: pending && !confirmed, confirmed }
}

export default function AuthPage() {
  const nav = useNavigate()
  const [searchParams] = useSearchParams()
  const [mode, setMode] = useState<'login' | 'register'>(() => searchParams.get('mode') === 'register' ? 'register' : 'login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [user, setUser] = useState<User | null>(null)
  const [confirmExistingLogin, setConfirmExistingLogin] = useState(false)
  const [upgradeNotice, setUpgradeNotice] = useState('')
  const [resumeUpgrade, setResumeUpgrade] = useState(false)
  const [pendingUpgrade, setPendingUpgrade] = useState(false)

  useEffect(() => {
    const controller = new AbortController()
    // 預熱後端，讓填表時間與冷啟動重疊；失敗不阻擋 Supabase 登入／註冊。
    void fetch(`${import.meta.env.VITE_API_URL ?? ''}/healthz`, {
      method: 'GET',
      cache: 'no-store',
      credentials: 'omit',
      signal: controller.signal,
    }).catch(() => {})
    let active = true
    const applyUser = (current: User | null) => {
      if (!active) return
      setUser(current)
      const upgradeEmail = current && localStorage.getItem(`guest-upgrade:${current.id}`)
      if (current && !current.is_anonymous && upgradeEmail) {
        const upgrade = guestUpgradeState(current, upgradeEmail)
        setResumeUpgrade(upgrade.confirmed)
        setPendingUpgrade(upgrade.pending)
        setMode('register')
        setEmail(upgradeEmail)
      } else {
        setResumeUpgrade(false)
        setPendingUpgrade(false)
      }
    }
    const refreshUser = () => void supabase.auth.getUser().then(({ data }) => applyUser(data.user)).catch(() => {})
    refreshUser()
    const { data: authSub } = supabase.auth.onAuthStateChange(() => {
      // Supabase advises against awaiting another auth call inside this callback.
      queueMicrotask(refreshUser)
    })
    return () => {
      active = false
      controller.abort()
      authSub.subscription.unsubscribe()
    }
  }, [])

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const registrationEmail = email.trim()
    if (mode === 'register' && (registrationEmail.length > 254 || registrationEmail.split('@')[0].length > 64 || !registrationEmailPattern.test(registrationEmail))) {
      setError('請輸入完整的 Email，例如 you@example.com')
      return
    }
    setBusy(true)
    try {
      const { data: sessionData, error: sessionError } = await supabase.auth.getSession()
      if (sessionError) throw sessionError
      const currentUser = sessionData.session?.user ?? null
      if (mode === 'register' && resumeUpgrade && currentUser) {
        const upgradeEmail = localStorage.getItem(`guest-upgrade:${currentUser.id}`)
        if (!guestUpgradeState(currentUser, upgradeEmail).confirmed) {
          setResumeUpgrade(false)
          setPendingUpgrade(!!upgradeEmail)
          setUpgradeNotice('請先完成 Email 驗證，再回來設定密碼。')
          return
        }
        const { error: passwordError } = await supabase.auth.updateUser({ password })
        if (passwordError) throw passwordError
        localStorage.removeItem(`guest-upgrade:${currentUser.id}`)
        const returnTo = sessionStorage.getItem(`guest-upgrade-return:${currentUser.id}`) ?? '/'
        sessionStorage.removeItem(`guest-upgrade-return:${currentUser.id}`)
        nav(returnTo, { replace: true })
        return
      }
      const upgradeEmail = currentUser && localStorage.getItem(`guest-upgrade:${currentUser.id}`)
      if (mode === 'register' && currentUser && (currentUser.is_anonymous || guestUpgradeState(currentUser, upgradeEmail).pending)) {
        const token = sessionData.session?.access_token
        if (!token) throw new Error('missing session')
        const validation = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/auth/validate-upgrade-email`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: registrationEmail }),
        })
        if (!validation.ok) {
          const body = await validation.json().catch(() => ({})) as { error?: string }
          throw new Error(body.error ?? 'upgrade validation failed')
        }
        const emailRedirectTo = `${window.location.origin}${window.location.pathname}${window.location.search}#/auth`
        localStorage.setItem(`guest-upgrade:${currentUser.id}`, registrationEmail.toLowerCase())
        const { error: updateError } = await supabase.auth.updateUser({ email: registrationEmail }, { emailRedirectTo })
        if (updateError) throw updateError
        setUpgradeNotice('驗證信已寄出。請先完成 Email 驗證，再回來設定密碼；目前訪客房籍與紀錄都會保留。')
        return
      }
      if (mode === 'login' && currentUser && (currentUser.is_anonymous || !!upgradeEmail)) {
        setConfirmExistingLogin(true)
        return
      }
      if (mode === 'register') {
        const emailRedirectTo = `${window.location.origin}${window.location.pathname}${window.location.search}#/auth`
        const { data, error } = await supabase.auth.signUp({
          email: registrationEmail,
          password,
          options: { data: { display_name: displayName }, emailRedirectTo },
        })
        if (error) setError(authErrorMessage(error))
        else if (!data.session) setUpgradeNotice('驗證信已寄出。請完成 Email 驗證後回來登入。')
        else nav('/')
      } else {
        const { error } = await supabase.auth.signInWithPassword({ email, password })
        if (error) setError(authErrorMessage(error))
        else nav('/')
      }
    } catch (error) {
      setError(authErrorMessage(error instanceof Error ? error : { message: '' }))
    } finally {
      setBusy(false)
    }
  }

  async function switchToExistingAccount() {
    setBusy(true)
    setError('')
    try {
      const { data } = await supabase.auth.getSession()
      const token = data.session?.access_token
      if (!token) throw new Error('missing session')
      const leave = await fetch(`${import.meta.env.VITE_API_URL ?? ''}/api/leave`, {
        method: 'POST', headers: { Authorization: `Bearer ${token}` },
      })
      if (!leave.ok) {
        setError('離開目前房間失敗，仍保留訪客身分；請稍後再試')
        return
      }
      const { error: loginError } = await supabase.auth.signInWithPassword({ email, password })
      if (loginError) setError(authErrorMessage(loginError))
      else nav('/')
    } catch (caught) {
      setError(authErrorMessage(caught instanceof Error ? caught : { message: '' }))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 p-5"
      inert={confirmExistingLogin}>
      <div className="animate-rise flex flex-col items-center gap-3 text-center">
        <Logo className="h-14 w-14" />
        <h1 className="text-3xl font-bold tracking-tight">今天吃什麼</h1>
        <p className="text-sm text-fg-muted">一群人各自設條件，五分鐘內轉出今天的店</p>
      </div>

      <div className="card animate-rise space-y-4">
        <div className="grid grid-cols-2 gap-1 rounded-xl bg-brand-soft p-1">
          {(['login', 'register'] as const).map(m => (
            <button key={m} type="button" aria-pressed={mode === m}
              className={`min-h-11 rounded-lg text-sm font-semibold transition-colors duration-150 ${
                mode === m ? 'bg-surface text-brand shadow-sm' : 'text-brand-strong'
              }`}
              onClick={() => {
                if (mode === m) return
                setMode(m)
                setPassword('')
                setError('')
              }}>
              {m === 'login' ? '登入' : '註冊'}
            </button>
          ))}
        </div>

        <form onSubmit={submit} className="space-y-3">
          {mode === 'register' && !user?.is_anonymous && !resumeUpgrade && !pendingUpgrade && (
            <div className="space-y-1">
              <label className="label" htmlFor="displayName">顯示名稱</label>
              <input id="displayName" className="field" placeholder="房間裡看到的名字"
                value={displayName} onChange={e => setDisplayName(e.target.value)} required maxLength={80} />
            </div>
          )}
          {(mode === 'login' || !resumeUpgrade) && <div className="space-y-1">
            <label className="label" htmlFor="email">Email</label>
            <input id="email" className="field" type="email" autoComplete="email"
              placeholder="you@example.com"
              value={email} onChange={e => setEmail(e.target.value)} required />
          </div>}
          {!(mode === 'register' && (user?.is_anonymous || pendingUpgrade)) && <div className="space-y-1">
            <label className="label" htmlFor="password">密碼</label>
            <input id="password" className="field" type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder="至少 6 碼"
              value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
          </div>}
          {error && !confirmExistingLogin && (
            <p role="alert" className="banner bg-danger-soft text-danger">
              <Alert className="h-5 w-5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
          {upgradeNotice && <p role="status" className="banner bg-brand-soft text-brand-strong">{upgradeNotice}</p>}
          <button className="btn btn-primary w-full" type="submit" disabled={busy}>
            {busy && <Spinner className="h-5 w-5" />}
            {mode === 'login' ? '登入' : resumeUpgrade ? '完成註冊' : user?.is_anonymous || pendingUpgrade ? '寄送驗證信' : '建立帳號'}
          </button>
        </form>
      </div>

    </main>
      {confirmExistingLogin && LeaveConfirm({
        title: '切換到既有帳號？',
        onClose: () => setConfirmExistingLogin(false),
        actionsClassName: 'sm:flex-row',
        actions: (
          <>
            <button autoFocus className="btn btn-quiet flex-1" type="button"
              onClick={() => setConfirmExistingLogin(false)}>取消</button>
            <button className="btn btn-primary flex-1" type="button" disabled={busy}
              onClick={switchToExistingAccount}>離房並登入</button>
          </>
        ),
        children: <>
          <p className="text-sm text-fg-muted">必須先離開目前房間。訪客紀錄不會合併到既有帳號；離席或登入失敗時不會切換身分。</p>
          {error && <p role="alert" className="banner bg-danger-soft text-danger">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{error}</span>
          </p>}
        </>,
      })}
    </>
  )
}

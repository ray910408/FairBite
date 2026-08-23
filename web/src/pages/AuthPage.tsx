import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { authErrorMessage } from '../lib/authErrors'
import { supabase } from '../lib/supabase'
import { Alert, Logo, Spinner } from '../components/icons'

export default function AuthPage() {
  const nav = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { error } =
        mode === 'register'
          ? await supabase.auth.signUp({
              email,
              password,
              options: { data: { display_name: displayName } },
            })
          : await supabase.auth.signInWithPassword({ email, password })
      if (error) setError(authErrorMessage(error))
      else nav('/')
    } finally {
      setBusy(false)
    }
  }

  return (
    <main className="mx-auto flex min-h-screen w-full max-w-sm flex-col justify-center gap-6 p-5">
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
          {mode === 'register' && (
            <div className="space-y-1">
              <label className="label" htmlFor="displayName">顯示名稱</label>
              <input id="displayName" className="field" placeholder="房間裡看到的名字"
                value={displayName} onChange={e => setDisplayName(e.target.value)} required />
            </div>
          )}
          <div className="space-y-1">
            <label className="label" htmlFor="email">Email</label>
            <input id="email" className="field" type="email" autoComplete="email"
              placeholder="you@example.com"
              value={email} onChange={e => setEmail(e.target.value)} required />
          </div>
          <div className="space-y-1">
            <label className="label" htmlFor="password">密碼</label>
            <input id="password" className="field" type="password"
              autoComplete={mode === 'register' ? 'new-password' : 'current-password'}
              placeholder="至少 6 碼"
              value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
          </div>
          {error && (
            <p role="alert" className="banner bg-danger-soft text-danger">
              <Alert className="h-5 w-5 shrink-0" />
              <span>{error}</span>
            </p>
          )}
          <button className="btn btn-primary w-full" type="submit" disabled={busy}>
            {busy && <Spinner className="h-5 w-5" />}
            {mode === 'login' ? '登入' : '建立帳號'}
          </button>
        </form>
      </div>
    </main>
  )
}

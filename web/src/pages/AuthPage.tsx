import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function AuthPage() {
  const nav = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const { error } =
      mode === 'register'
        ? await supabase.auth.signUp({
            email,
            password,
            options: { data: { display_name: displayName } },
          })
        : await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    else nav('/')
  }

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 p-4">
      <h1 className="text-2xl font-bold">今天吃什麼</h1>
      <form onSubmit={submit} className="space-y-3">
        {mode === 'register' && (
          <input className="w-full rounded border p-2" placeholder="顯示名稱"
            value={displayName} onChange={e => setDisplayName(e.target.value)} required />
        )}
        <input className="w-full rounded border p-2" type="email" placeholder="Email"
          value={email} onChange={e => setEmail(e.target.value)} required />
        <input className="w-full rounded border p-2" type="password" placeholder="密碼（至少 6 碼）"
          value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="w-full rounded bg-orange-500 p-2 text-white" type="submit">
          {mode === 'login' ? '登入' : '註冊'}
        </button>
      </form>
      <button className="text-sm text-gray-500 underline"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? '沒有帳號？註冊' : '已有帳號？登入'}
      </button>
    </div>
  )
}
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { Alert, Logo, LogOut, Spinner } from '../components/icons'

const FALLBACK = { lat: 25.0478, lng: 121.517 } // 台北車站：拒絕定位時的 demo 預設

function getPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(FALLBACK)
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(FALLBACK),
      { timeout: 5000 },
    )
  })
}

export default function HomePage() {
  const nav = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function createRoom() {
    setBusy(true)
    setError('')
    try {
      const pos = await getPosition()
      const { data, error } = await supabase.rpc('create_room', {
        p_lat: pos.lat, p_lng: pos.lng,
      })
      if (error) setError(error.message)
      else nav(`/room/${data}`)
    } finally {
      setBusy(false)
    }
  }

  async function joinRoom(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('join_room', { p_code: code })
      if (error || !data) {
        setError(error?.message?.includes('頻繁')
          ? '嘗試過於頻繁，請稍後再試'
          : '房間不存在或已開始')
      } else nav(`/room/${data}`)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="min-h-screen">
      <header className="mx-auto flex w-full max-w-md items-center justify-between p-4">
        <div className="flex items-center gap-2">
          <Logo className="h-8 w-8" />
          <span className="text-lg font-bold">今天吃什麼</span>
        </div>
        <button className="btn btn-quiet min-h-11 px-3 text-sm" onClick={() => supabase.auth.signOut()}>
          <LogOut className="h-4 w-4" />
          登出
        </button>
      </header>

      <main className="mx-auto w-full max-w-md space-y-4 p-4">
        <section className="card animate-rise space-y-3 bg-linear-to-b from-brand-soft to-surface">
          <h1 className="text-2xl font-bold tracking-tight">開一場聚餐決策</h1>
          <p className="text-sm text-fg-muted">
            以你現在的位置為中心建立房間，把邀請碼給大家，各自設好條件就能開始搜尋。
          </p>
          <button onClick={createRoom} disabled={busy} className="btn btn-primary w-full">
            {busy && <Spinner className="h-5 w-5" />}
            {busy ? '定位中…' : '建立房間'}
          </button>
        </section>

        <section className="card animate-rise space-y-3">
          <h2 className="text-base font-semibold">已經有邀請碼？</h2>
          <form onSubmit={joinRoom} className="flex gap-2">
            <input className="field flex-1 font-mono text-lg tracking-[0.3em] uppercase"
              aria-label="邀請碼" placeholder="ABC123" autoCapitalize="characters"
              value={code} onChange={e => setCode(e.target.value)} required maxLength={6} />
            <button className="btn btn-quiet px-5" type="submit" disabled={busy}>加入</button>
          </form>
        </section>

        {error && (
          <p role="alert" className="banner bg-danger-soft text-danger">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{error}</span>
          </p>
        )}
      </main>
    </div>
  )
}

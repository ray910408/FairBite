import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

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
    const pos = await getPosition()
    const { data, error } = await supabase.rpc('create_room', {
      p_lat: pos.lat, p_lng: pos.lng,
    })
    setBusy(false)
    if (error) setError(error.message)
    else nav(`/room/${data}`)
  }

  async function joinRoom(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const { data, error } = await supabase.rpc('join_room', { p_code: code })
    if (error) setError('房間不存在或已開始')
    else nav(`/room/${data}`)
  }

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-6 p-4">
      <h1 className="text-2xl font-bold">今天吃什麼</h1>
      <button onClick={createRoom} disabled={busy}
        className="w-full rounded bg-orange-500 p-3 text-white disabled:opacity-50">
        {busy ? '定位中…' : '建立房間'}
      </button>
      <form onSubmit={joinRoom} className="flex gap-2">
        <input className="flex-1 rounded border p-2 uppercase" placeholder="邀請碼"
          value={code} onChange={e => setCode(e.target.value)} required maxLength={6} />
        <button className="rounded bg-gray-800 px-4 text-white" type="submit">加入</button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="text-sm text-gray-500 underline"
        onClick={() => supabase.auth.signOut()}>登出</button>
    </div>
  )
}

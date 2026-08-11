import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { CUISINE_LABEL, CUISINE_OPTIONS } from '../lib/labels'
import { suggestCuisines, type HistoryRow } from '../lib/prefsLearning'
import { Alert, Logo, LogOut, Spinner } from '../components/icons'
import { RecentRatingPrompt } from '../components/RatingPrompt'

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

// default_prefs 帶入（spec §4；eng review D18 客戶端直寫版，取代 RPC 五欄位框架）：
// 建/加成功後、導頁前，若有預設偏好就寫進自己的 member row（lobby 的 members_update
// RLS 本來就允許）。失敗只影響預設值（罕見：搜尋凍結競態），靜默接受不擋導頁。
async function applyDefaultPrefs(roomId: string) {
  const { data: auth } = await supabase.auth.getUser()
  if (!auth.user) return
  const appliedKey = `prefs-applied:${roomId}:${auth.user.id}`
  if (localStorage.getItem(appliedKey)) return
  const { data: profile, error: profileError } = await supabase.from('profiles')
    .select('default_prefs').eq('id', auth.user.id).single()
  if (profileError) return
  const cuisines = (profile?.default_prefs as { cuisines?: string[] } | null)?.cuisines
  if (!Array.isArray(cuisines) || cuisines.length === 0) {
    localStorage.setItem(appliedKey, '1')
    return
  }
  const { error } = await supabase.from('room_members').update({ cuisines })
    .eq('room_id', roomId).eq('user_id', auth.user.id)
    .eq('cuisines', '[]') // 只填仍是預設的列：重複加入不得覆蓋使用者已調好的條件（task6 review r1）
  if (!error) localStorage.setItem(appliedKey, '1')
}

export default function HomePage() {
  const nav = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [myUserId, setMyUserId] = useState('')
  const [prefs, setPrefs] = useState<Record<string, unknown>>({})
  const [suggestion, setSuggestion] = useState<string[]>([])
  const suggestionRequest = useRef(0)
  const suggestionsMounted = useRef(false)

  const loadSuggestions = useCallback(async () => {
    if (!suggestionsMounted.current) return
    const request = ++suggestionRequest.current
    setSuggestion([]) // 評分後先撤下舊快照，避免 refetch 完成前仍可採納已失效建議
    const { data: auth } = await supabase.auth.getUser()
    if (!auth.user || request !== suggestionRequest.current) return
    const [{ data: profile }, { data: history }, { data: lowRows }] = await Promise.all([
      supabase.from('profiles').select('default_prefs').eq('id', auth.user.id).single(),
      supabase.from('dining_history')
        .select('rating, restaurants(cuisine_tags)')
        .order('decided_at', { ascending: false }).limit(50),
      supabase.from('dining_history')
        .select('rating, restaurants(cuisine_tags)').lte('rating', 2),
    ])
    if (request !== suggestionRequest.current || !profile) return
    const dp = (profile?.default_prefs ?? {}) as Record<string, unknown>
    const current = Array.isArray(dp.cuisines) ? (dp.cuisines as string[]) : []
    const tags = suggestCuisines([...(lowRows ?? []), ...(history ?? [])] as unknown as HistoryRow[], current,
      CUISINE_OPTIONS.map(([k]) => k))
    const dismissed = (localStorage.getItem(`prefs-suggest-dismissed:${auth.user.id}`) ?? '').split(',')
    setMyUserId(auth.user.id)
    setPrefs(dp)
    setSuggestion(tags.filter(t => !dismissed.includes(t)))
  }, [])

  const cancelSuggestionLoads = useCallback(() => {
    suggestionsMounted.current = false
    suggestionRequest.current++
  }, [])

  useEffect(() => {
    suggestionsMounted.current = true
    void loadSuggestions()
    return cancelSuggestionLoads
  }, [cancelSuggestionLoads, loadSuggestions])

  async function createRoom() {
    setBusy(true)
    setError('')
    try {
      const pos = await getPosition()
      const { data, error } = await supabase.rpc('create_room', {
        p_lat: pos.lat, p_lng: pos.lng,
      })
      if (error) setError(error.message)
      else {
        await applyDefaultPrefs(data)
        nav(`/room/${data}`)
      }
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
      } else {
        await applyDefaultPrefs(data)
        nav(`/room/${data}`)
      }
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
              aria-label="邀請碼" placeholder="A1B2C3D4E5F6" autoCapitalize="characters"
              value={code} onChange={e => setCode(e.target.value)} required maxLength={12} />
            <button className="btn btn-quiet px-5" type="submit" disabled={busy}>加入</button>
          </form>
        </section>

        {suggestion.length > 0 && (
          <section className="card animate-rise space-y-2">
            <p className="text-sm">
              根據你的用餐紀錄，你常吃：
              <span className="font-semibold">
                {suggestion.map(t => CUISINE_LABEL[t] ?? t).join('、')}
              </span>
              。要加入預設偏好嗎？之後開房會自動帶入。
            </p>
            <div className="flex gap-2">
              <button className="btn btn-primary flex-1" onClick={async () => {
                const cur = Array.isArray(prefs.cuisines) ? (prefs.cuisines as string[]) : []
                const { error } = await supabase.from('profiles').update({
                  default_prefs: { ...prefs, cuisines: [...new Set([...cur, ...suggestion])] },
                }).eq('id', myUserId)
                if (!error) setSuggestion([])
                else setError('偏好儲存失敗，請稍後再試')
              }}>加入預設偏好</button>
              <button className="btn btn-quiet" onClick={() => {
                const dismissedKey = `prefs-suggest-dismissed:${myUserId}`
                const prev = (localStorage.getItem(dismissedKey) ?? '').split(',')
                localStorage.setItem(dismissedKey,
                  [...new Set([...prev, ...suggestion])].filter(Boolean).join(','))
                setSuggestion([])
              }}>忽略</button>
            </div>
          </section>
        )}

        <RecentRatingPrompt onRated={loadSuggestions} />

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

import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { CUISINE_LABEL, CUISINE_OPTIONS } from '../lib/labels'
import { buildMealTimeISO } from '../lib/mealTime'
import { suggestCuisines, type HistoryRow } from '../lib/prefsLearning'
import { loadLastDeparture, saveLastDeparture, type DeparturePoint } from '../lib/departure'
import { getUid } from '../lib/uid'
import { Alert, Logo, LogOut, Spinner } from '../components/icons'
import LocationPicker from '../components/LocationPicker'
import { RecentRatingPrompt } from '../components/RatingPrompt'

// default_prefs 帶入（spec §4；eng review D18 客戶端直寫版，取代 RPC 五欄位框架）：
// 建/加成功後、導頁前，若有預設偏好就寫進自己的 member row（lobby 的 members_update
// RLS 本來就允許）。失敗只影響預設值（罕見：搜尋凍結競態），靜默接受不擋導頁。
async function applyDefaultPrefs(roomId: string) {
  const uid = await getUid()
  if (!uid) return
  const appliedKey = `prefs-applied:${roomId}:${uid}`
  if (localStorage.getItem(appliedKey)) return
  const { data: profile, error: profileError } = await supabase.from('profiles')
    .select('default_prefs').eq('id', uid).single()
  if (profileError) return
  const raw = (profile?.default_prefs as { cuisines?: string[] } | null)?.cuisines
  // 詞彙可能收縮（如 2026-08-13 移除 sichuan）：只帶入仍在選單上的 tag，
  // 免得既存預設偏好裡的死選項繼續拖低滿足度 EMA（永無 pref hit）
  const allowed = new Set(CUISINE_OPTIONS.map(([k]) => k))
  const cuisines = Array.isArray(raw) ? raw.filter(c => allowed.has(c)) : raw
  if (!Array.isArray(cuisines) || cuisines.length === 0) {
    localStorage.setItem(appliedKey, '1')
    return
  }
  const { error } = await supabase.from('room_members').update({ cuisines })
    .eq('room_id', roomId).eq('user_id', uid)
    .eq('cuisines', '[]') // 只填仍是預設的列：重複加入不得覆蓋使用者已調好的條件（task6 review r1）
  if (!error) localStorage.setItem(appliedKey, '1')
}

export default function HomePage() {
  const nav = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [departure, setDeparture] = useState<DeparturePoint | null>(null)
  const [mealMode, setMealMode] = useState<'now' | 'custom'>('now')
  const [mealHH, setMealHH] = useState('')
  const [mealMM, setMealMM] = useState('')
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
    const uid = await getUid()
    if (!uid || request !== suggestionRequest.current) return
    setDeparture(prev => prev ?? loadLastDeparture(uid))
    const [{ data: profile }, { data: history }, { data: lowRows }] = await Promise.all([
      supabase.from('profiles').select('default_prefs').eq('id', uid).single(),
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
    const dismissed = (localStorage.getItem(`prefs-suggest-dismissed:${uid}`) ?? '').split(',')
    setMyUserId(uid)
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

  async function persistRoom(pos: DeparturePoint) {
    const creatorUid = await getUid()
    if (!creatorUid) return
    let mealISO: string | null = null
    if (mealMode === 'custom') {
      if (!mealHH || !mealMM) {
        setError('請選擇完整的用餐時間')
        return
      }
      const r = buildMealTimeISO(`${mealHH}:${mealMM}`)
      if ('error' in r) {
        setError(r.error)
        return
      }
      mealISO = r.iso
    }
    const { data, error } = await supabase.rpc('create_room', {
      p_lat: pos.lat, p_lng: pos.lng,
    })
    if (error) {
      setError(error.message)
      return
    }
    if (mealISO) {
      // 失敗靜默接受：房間以「馬上出發」存在，lobby 可重設（spec §4）
      await supabase.from('rooms').update({ meal_time: mealISO }).eq('id', data)
    }
    await applyDefaultPrefs(data)
    saveLastDeparture(creatorUid, pos)
    nav(`/room/${data}`)
  }

  async function createRoom() {
    if (!departure) return
    setBusy(true)
    setError('')
    try {
      await persistRoom(departure)
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
        <div className="flex items-center gap-2">
          <Link to="/history" className="btn btn-quiet min-h-11 px-3 text-sm">足跡</Link>
          <button className="btn btn-quiet min-h-11 px-3 text-sm" onClick={() => supabase.auth.signOut()}>
            <LogOut className="h-4 w-4" />
            登出
          </button>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md space-y-4 p-4">
        <section className="card animate-rise space-y-3 bg-linear-to-b from-brand-soft to-surface">
          <h1 className="text-2xl font-bold tracking-tight">開一場聚餐決策</h1>
          <p className="text-sm text-fg-muted">
            選好出發點與用餐時間建立房間，把邀請碼給大家，各自設好條件就能開始搜尋。
          </p>
          <LocationPicker value={departure} onChange={setDeparture} />
          <div className="space-y-2">
            <span className="text-sm font-semibold text-fg-muted">用餐時間</span>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-brand-soft p-1">
              {([['now', '馬上出發'], ['custom', '自訂時間']] as const).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={mealMode === key}
                  className={`min-h-10 rounded-lg text-sm font-semibold transition-colors duration-150 ${
                    mealMode === key ? 'bg-surface text-brand shadow-sm' : 'text-brand-strong'
                  }`}
                  onClick={() => setMealMode(key)}>
                  {label}
                </button>
              ))}
            </div>
            {mealMode === 'custom' && (
              <div className="flex items-center gap-2">
                <select className="field flex-1" aria-label="用餐時間（時）"
                  value={mealHH}
                  onChange={e => setMealHH(e.target.value)}>
                  <option value="" disabled>時</option>
                  {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')).map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span className="text-fg-muted">:</span>
                <select className="field flex-1" aria-label="用餐時間（分）"
                  value={mealMM}
                  onChange={e => setMealMM(e.target.value)}>
                  <option value="" disabled>分</option>
                  {Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0')).map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <button onClick={createRoom} disabled={busy || !departure} className="btn btn-primary w-full">
            {busy && <Spinner className="h-5 w-5" />}
            {busy ? '建立中…' : '建立房間'}
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

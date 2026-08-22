import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { CUISINE_LABEL, CUISINE_OPTIONS } from '../lib/labels'
import { leaveNotice } from '../lib/leaveNotice'
import { buildMealTimeISO } from '../lib/mealTime'
import { suggestCuisines, type HistoryRow } from '../lib/prefsLearning'
import { loadLastDeparture, saveLastDeparture, type DeparturePoint } from '../lib/departure'
import { fetchLeaveRooms, type LeaveTarget } from '../lib/roomMembership'
import { getUid } from '../lib/uid'
import { Alert, Logo, LogOut, Spinner } from '../components/icons'
import { LeaveConfirm } from '../components/LeaveConfirm'
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
  const [createError, setCreateError] = useState('')
  const [joinError, setJoinError] = useState('')
  const [prefsError, setPrefsError] = useState('')
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
  // 回首頁＝離席（ADR-0007）：settle 前禁用建房/加入，避免晚到的 leave 誤刪新房
  const [leavePending, setLeavePending] = useState(true)
  // 離席確認的對象（ADR-0007 2026-08-16 修訂）——新 state 一律接在最後，
  // HomePage.test.ts 依 useState 呼叫順序 mock
  const [leaveTarget, setLeaveTarget] = useState<LeaveTarget | null>(null)
  const [suggestionLoadError, setSuggestionLoadError] = useState('')
  const location = useLocation()
  // 每次 mount 只做一次離席決策：消耗旗標的 replace 會讓 location 變、下面的 effect
  // 重跑，沒有這道閘就會在 doLeave() 還在飛的時候又走一次查房籍→開 dialog
  const leaveDecided = useRef(false)

  const handleDepartureChange = useCallback((p: DeparturePoint) => {
    setDeparture(p)
    setCreateError('')
  }, [])

  const loadSuggestions = useCallback(async () => {
    if (!suggestionsMounted.current) return
    const request = ++suggestionRequest.current
    setSuggestion([]) // 評分後先撤下舊快照，避免 refetch 完成前仍可採納已失效建議
    const uid = await getUid()
    if (!uid || request !== suggestionRequest.current) return
    const [
      { data: profile, error: profileError },
      { data: history, error: historyError },
      { data: lowRows, error: lowRowsError },
    ] = await Promise.all([
      supabase.from('profiles').select('default_prefs').eq('id', uid).single(),
      supabase.from('dining_history')
        .select('rating, restaurants(cuisine_tags)')
        .order('decided_at', { ascending: false }).limit(50),
      supabase.from('dining_history')
        .select('rating, restaurants(cuisine_tags)').lte('rating', 2),
    ])
    if (request !== suggestionRequest.current || !suggestionsMounted.current) return
    if (profileError || historyError || lowRowsError) {
      setSuggestionLoadError('口味建議暫時載入失敗；不影響建房與本次房內條件')
      return
    }
    if (!profile) return
    const dp = (profile.default_prefs ?? {}) as Record<string, unknown>
    const current = Array.isArray(dp.cuisines) ? (dp.cuisines as string[]) : []
    const tags = suggestCuisines([...(lowRows ?? []), ...(history ?? [])] as unknown as HistoryRow[], current,
      CUISINE_OPTIONS.map(([k]) => k))
    const dismissed = (localStorage.getItem(`prefs-suggest-dismissed:${uid}`) ?? '').split(',')
    setDeparture(prev => prev ?? loadLastDeparture(uid))
    setMyUserId(uid)
    setPrefs(dp)
    setSuggestion(tags.filter(t => !dismissed.includes(t)))
    setSuggestionLoadError('')
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

  // 退房是所有路徑的共同終點：leavePending 直到 settle 才解除，期間建房/加入維持禁用
  const doLeave = useCallback(() => {
    void import('../lib/api').then(m => m.leaveRooms()).finally(() => setLeavePending(false))
  }, [])

  // mount 是所有繞過路徑的共同咽喉（瀏覽器上一頁、手機返回手勢、直接輸網址、
  // 關分頁後重開）——在終點攔一次就全覆蓋，比在每個「回首頁」連結上打地鼠可靠
  //（ADR-0007 2026-08-16 修訂，PR #17 Codex review 裁定）。
  // 三條分支：查到房間先問（不退）／查到空就沒房可退（不打 /api/leave）／
  // 查詢失敗一律不退，開保守 dialog 讓使用者自己決定——靜默退房是不可逆的。
  useEffect(() => {
    if (leaveDecided.current) return
    leaveDecided.current = true
    // RoomPage／HistoryPage 的離席確認會帶 leaveConfirmed 過來：使用者剛看過完整後果，
    // 再問一次就是同一份 dialog 連跳兩張。但旗標是掛在 history entry 上的，重整會還原、
    // 上一頁回到同一筆 entry 也會還原——不當場消耗掉，「退房→建新房→上一頁」就會靜默
    // 退掉新房，正好從這裡替本攔截要防的繞過開後門。replace 掉才是真的只用一次。
    if ((location.state as { leaveConfirmed?: boolean } | null)?.leaveConfirmed === true) {
      nav(location.pathname, { replace: true, state: null })
      doLeave()
      return
    }
    void fetchLeaveRooms().then(rooms => {
      if (rooms && rooms.length === 0) setLeavePending(false) // room_members 就是權威
      else setLeaveTarget(rooms ? { kind: 'rooms', rooms } : { kind: 'unknown' })
    })
  }, [location, nav, doLeave])

  function confirmLeave() {
    setLeaveTarget(null)
    doLeave()
  }

  async function persistRoom(pos: DeparturePoint) {
    const creatorUid = await getUid()
    if (!creatorUid) return
    let mealISO: string | null = null
    if (mealMode === 'custom') {
      if (!mealHH || !mealMM) {
        setCreateError('請選擇完整的用餐時間')
        return
      }
      const r = buildMealTimeISO(`${mealHH}:${mealMM}`)
      if ('error' in r) {
        setCreateError(r.error)
        return
      }
      mealISO = r.iso
    }
    const { data, error } = await supabase.rpc('create_room', {
      p_lat: pos.lat, p_lng: pos.lng,
    })
    if (error) {
      setCreateError(error.message)
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
    setCreateError('')
    try {
      await persistRoom(departure)
    } finally {
      setBusy(false)
    }
  }

  async function joinRoom(e: React.FormEvent) {
    e.preventDefault()
    setJoinError('')
    setBusy(true)
    try {
      const { data, error } = await supabase.rpc('join_room', { p_code: code })
      if (error || !data) {
        setJoinError(error?.message?.includes('頻繁')
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
    <>
      {/* dialog 開著時整塊背景 inert：fixed 遮罩擋得住指標，對 tab 順序毫無作用——
          沒有它鍵盤使用者可以 tab 到「建立房間」按 Enter，繞過還沒決定的退房（Codex P2） */}
      <div className="min-h-screen" inert={!!leaveTarget}>
      <header className="mx-auto flex w-full max-w-md items-center justify-between p-4">
        <div className="flex items-center gap-2">
          <Logo className="h-8 w-8" />
          <span className="text-lg font-bold">今天吃什麼</span>
        </div>
        <div className="flex flex-col items-end gap-1">
          <div className="flex items-center gap-2">
            <Link to="/history" className="btn btn-quiet min-h-11 px-3 text-sm">足跡</Link>
          {/* 登出走同一道 leavePending 閘門（比照建房/加入）：查房籍還在飛、或確認 dialog
              開著時登出，App.tsx 的 auth listener 會卸載本頁，doLeave() 永遠不會執行，
              伺服器端房籍留著——該使用者變成幽靈成員，條件與票繼續約束房間盤面。
              閘門不會鎖死：fetchLeaveRooms 有 5 秒逾時，逾時也會開出 dialog，
              兩顆按鈕都會讓 leavePending settle（roomMembership.test.ts 釘住那條出口） */}
          <button className="btn btn-quiet min-h-11 px-3 text-sm" disabled={leavePending}
            onClick={() => supabase.auth.signOut()}>
            <LogOut className="h-4 w-4" />
            登出
          </button>
          </div>
          {leavePending && (
            <p role="status" className="max-w-52 text-right text-xs text-fg-muted">
              正在確認房間狀態，確認後才能登出
            </p>
          )}
        </div>
      </header>

      <main className="mx-auto w-full max-w-md space-y-4 p-4">
        <section className="card animate-rise space-y-3 bg-linear-to-b from-brand-soft to-surface">
          <h1 className="text-2xl font-bold tracking-tight">開一場聚餐決策</h1>
          <p className="text-sm text-fg-muted">
            選好出發點與用餐時間建立房間，把邀請碼給大家，各自設好條件就能開始搜尋。
          </p>
          <LocationPicker value={departure} onChange={handleDepartureChange} />
          <div className="space-y-2">
            <span className="text-sm font-semibold text-fg-muted">用餐時間</span>
            <div className="grid grid-cols-2 gap-1 rounded-xl bg-brand-soft p-1">
              {([['now', '馬上出發'], ['custom', '自訂時間']] as const).map(([key, label]) => (
                <button key={key} type="button" aria-pressed={mealMode === key}
                  className={`min-h-11 rounded-lg text-sm font-semibold transition-colors duration-150 ${
                    mealMode === key ? 'bg-surface text-brand shadow-sm' : 'text-brand-strong'
                  }`}
                  onClick={() => { setMealMode(key); setCreateError('') }}>
                  {label}
                </button>
              ))}
            </div>
            {mealMode === 'custom' && (
              <div className="flex items-center gap-2">
                <select className="field flex-1" aria-label="用餐時間（時）"
                  value={mealHH}
                  onChange={e => { setMealHH(e.target.value); setCreateError('') }}>
                  <option value="" disabled>時</option>
                  {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')).map(h => (
                    <option key={h} value={h}>{h}</option>
                  ))}
                </select>
                <span className="text-fg-muted">:</span>
                <select className="field flex-1" aria-label="用餐時間（分）"
                  value={mealMM}
                  onChange={e => { setMealMM(e.target.value); setCreateError('') }}>
                  <option value="" disabled>分</option>
                  {Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0')).map(m => (
                    <option key={m} value={m}>{m}</option>
                  ))}
                </select>
              </div>
            )}
          </div>
          <button onClick={createRoom} disabled={busy || !departure || leavePending} className="btn btn-primary w-full">
            {busy && <Spinner className="h-5 w-5" />}
            {busy ? '建立中…' : '建立房間'}
          </button>
          {createError && (
            <p role="alert" className="banner bg-danger-soft text-danger">
              <Alert className="h-5 w-5 shrink-0" />
              <span>{createError}</span>
            </p>
          )}
        </section>

        <section className="card animate-rise space-y-3">
          <h2 className="text-base font-semibold">已經有邀請碼？</h2>
          <form onSubmit={joinRoom} className="flex gap-2">
            <input className="field flex-1 font-mono text-lg tracking-[0.3em] uppercase"
              aria-label="邀請碼" placeholder="A1B2C3D4E5F6" autoCapitalize="characters"
              value={code} onChange={e => { setCode(e.target.value); setJoinError('') }}
              required minLength={12} maxLength={12} pattern="[0-9A-Fa-f]{12}" />
            <button className="btn btn-quiet px-5" type="submit" disabled={busy || leavePending}>加入</button>
          </form>
          {joinError && (
            <p role="alert" className="banner bg-danger-soft text-danger">
              <Alert className="h-5 w-5 shrink-0" />
              <span>{joinError}</span>
            </p>
          )}
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
                setPrefsError('')
                const cur = Array.isArray(prefs.cuisines) ? (prefs.cuisines as string[]) : []
                const { error } = await supabase.from('profiles').update({
                  default_prefs: { ...prefs, cuisines: [...new Set([...cur, ...suggestion])] },
                }).eq('id', myUserId)
                if (!error) setSuggestion([])
                else setPrefsError('偏好儲存失敗，請稍後再試')
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

        {suggestionLoadError && (
          <p role="status" className="banner bg-warn-soft text-warn">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{suggestionLoadError}</span>
          </p>
        )}

        <RecentRatingPrompt onRated={loadSuggestions} />

        {prefsError && (
          <p role="alert" className="banner bg-danger-soft text-danger">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{prefsError}</span>
          </p>
        )}
      </main>
      </div>

      {leaveTarget && (() => {
        // leave 是全退（POST /api/leave 不挑房），所以每個房籍都要講
        const rooms = leaveTarget.kind === 'rooms' ? leaveTarget.rooms : []
        const multi = rooms.length > 1
        // 「回到房間」是 button 不是 Link：React 的 autoFocus 只對表單控制項生效，
        // 焦點必須落在安全那顆，不能落在「離開房間」上。
        // 不給 onClose（Esc）：留在首頁又不決定會讓建房/加入永遠禁用，不是合法終態。
        return LeaveConfirm({
          title: '你還在房間裡',
          actions: (
            <>
              {rooms.length === 1 && (
                <button type="button" autoFocus className="btn btn-primary w-full"
                  onClick={() => nav(`/room/${rooms[0].id}`)}>回到房間</button>
              )}
              {leaveTarget.kind === 'unknown' && (
                <button type="button" autoFocus className="btn btn-quiet w-full"
                  onClick={() => window.location.reload()}>重新整理再試</button>
              )}
              <button type="button" className="btn w-full bg-danger text-white"
                onClick={confirmLeave}>離開房間</button>
            </>
          ),
          children: (
            <>
              {leaveTarget.kind === 'unknown' && (
                <p className="text-sm text-fg-muted">
                  你可能還在房間裡，但房間現況查不到（連線可能不穩），離開後的影響無法確認
                  ——不確定就先重新整理再試，確定要走再按離開。
                </p>
              )}
              {rooms.length === 1 && (
                <p className="text-sm text-fg-muted">
                  你回到首頁了，但你還在房間 {rooms[0].code} 裡。離開後果如下：
                </p>
              )}
              {multi && (
                <p className="text-sm text-fg-muted">
                  你回到首頁了，但你還在 {rooms.length} 個房間裡，離開會一次全部離開：
                </p>
              )}
              {rooms.map((r, i) => (
                <div key={r.id} className={multi ? 'space-y-2 rounded-xl border border-border p-3' : ''}>
                  {multi && <p className="text-sm font-semibold">房間 {r.code}</p>}
                  <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
                    {leaveNotice(r.status, r.memberCount, r.code, r.isHost).map(p => <li key={p}>{p}</li>)}
                  </ul>
                  {/* 多房時回房入口掛在各房區塊內，不替使用者猜要回哪一間（比照 HistoryPage） */}
                  {multi && (
                    <button type="button" autoFocus={i === 0} className="btn btn-quiet w-full"
                      onClick={() => nav(`/room/${r.id}`)}>回到 {r.code}</button>
                  )}
                </div>
              ))}
            </>
          ),
        })
      })()}
    </>
  )
}

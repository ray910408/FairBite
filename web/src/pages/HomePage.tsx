import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { leaveRooms, wakeApi } from '../lib/api'
import { supabase } from '../lib/supabase'
import { CUISINE_LABEL, CUISINE_OPTIONS } from '../lib/labels'
import { getPosition } from '../lib/geolocation'
import { suggestCuisines } from '../lib/prefsLearning'
import { loadLastDeparture, saveLastDeparture, saveRoomDeparture, type DeparturePoint } from '../lib/departure'
import { fetchLeaveRooms, type LeaveTarget } from '../lib/roomMembership'
import { getUid } from '../lib/uid'
import { applyDefaultPrefs } from '../lib/defaultPrefs'
import { inviteCodeFromLink } from '../lib/invite'
import { addDismissed, readDismissed } from '../lib/dismissed'
import { Alert, Logo, LogOut, Spinner } from '../components/icons'
import { LeaveConfirm, LeaveRoomsList } from '../components/LeaveConfirm'
import { ThemeMenu } from '../components/ThemeMenu'
import LocationPicker from '../components/LocationPicker'
import { RecentRatingPrompt } from '../components/RatingPrompt'
import CustomWheel from '../components/CustomWheel'

const LOCATE_LIMIT_MS = 10_000
// create_room 的 raise exception 原文還是舊用詞；改 DB 文案要動 migration，前端換成畫面用詞
const CREATE_ROOM_MESSAGES: Record<string, string> = {
  '建房額度已用完，請稍後再試': '發起聚餐的次數已達上限，請稍後再試',
  '訪客需完成註冊後才能建立房間': '訪客需完成註冊後才能發起聚餐',
}

export default function HomePage() {
  const nav = useNavigate()
  const [code, setCode] = useState('')
  const [createError, setCreateError] = useState('')
  const [joinError, setJoinError] = useState('')
  const [prefsError, setPrefsError] = useState('')
  const [departure, setDeparture] = useState<DeparturePoint | null>(null)
  // 沒有上次出發點又抓不到定位：首頁才開選點
  const [locateFailed, setLocateFailed] = useState(false)
  const [busy, setBusy] = useState(false)
  const [myUserId, setMyUserId] = useState('')
  const [prefs, setPrefs] = useState<Record<string, unknown>>({})
  const [suggestion, setSuggestion] = useState<string[]>([])
  const suggestionRequest = useRef(0)
  const suggestionsMounted = useRef(false)
  // 回首頁＝離席（ADR-0007）：settle 前禁用建房/加入，避免晚到的 leave 誤刪新房
  const [leavePending, setLeavePending] = useState(true)
  // 離席確認的對象（ADR-0007 2026-08-16 修訂）
  const [leaveTarget, setLeaveTarget] = useState<LeaveTarget | null>(null)
  const [suggestionLoadError, setSuggestionLoadError] = useState('')
  const [authState, setAuthState] = useState<'checking' | 'guest' | 'member' | 'error'>('checking')
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
    if (!uid || request !== suggestionRequest.current || !suggestionsMounted.current) return
    // 口味查詢是附加功能；上次出發點先還原，任一查詢失敗也不能阻擋建房。
    setDeparture(prev => prev ?? loadLastDeparture(uid))
    const [
      { data: profile, error: profileError },
      { data: history, error: historyError },
      { data: lowRows, error: lowRowsError },
    ] = await Promise.all([
      supabase.rpc('get_my_default_prefs').single(),
      supabase.from('dining_history')
        .select('rating, restaurants(cuisine_tags)')
        .order('decided_at', { ascending: false }).limit(50),
      supabase.from('dining_history')
        .select('rating, restaurants(cuisine_tags)').lte('rating', 2),
    ])
    if (request !== suggestionRequest.current || !suggestionsMounted.current) return
    if (profileError || historyError || lowRowsError) {
      setSuggestionLoadError('口味建議暫時載入失敗；不影響發起聚餐與本次聚餐條件')
      return
    }
    if (!profile) return
    const dp = (profile.default_prefs ?? {}) as Record<string, unknown>
    const current = Array.isArray(dp.cuisines) ? (dp.cuisines as string[]) : []
    const tags = suggestCuisines([...(lowRows ?? []), ...(history ?? [])], current,
      CUISINE_OPTIONS.map(([k]) => k))
    const dismissed = readDismissed(`prefs-suggest-dismissed:${uid}`)
    setMyUserId(uid)
    setPrefs(dp)
    setSuggestion(tags.filter(t => !dismissed.includes(t)))
    setSuggestionLoadError('')
  }, [])

  const cancelSuggestionLoads = useCallback(() => {
    suggestionsMounted.current = false
    suggestionRequest.current++
  }, [])

  const loadAuthState = useCallback(async () => {
    setAuthState('checking')
    try {
      const { data, error } = await supabase.auth.getUser()
      if (error || !data.user) throw error ?? new Error('Missing user')
      const user = data.user
      // 封鎖網站資料時讀不到升級標記：當作沒有。半升級帳號照樣會被 DB 的 create_room 擋下，
      // 而封鎖時 AuthPage 寫標記那一步就會丟錯、升級停在送信前，這台裝置本來也走不到半升級
      let upgrading = false
      try { upgrading = localStorage.getItem(`guest-upgrade:${user.id}`) !== null } catch { /* 見上 */ }
      setAuthState(user.is_anonymous === true || upgrading ? 'guest' : 'member')
    } catch {
      setAuthState('error')
    }
  }, [])

  // 已登入的人不經過 AuthPage，建房與 lobby 都走 Supabase，沒有房要退時第一支打到 Render 的通常是「開始搜尋」：
  // 在這裡先喚醒，冷啟動才不會整段算在搜尋上。不 abort——建房後換到房間頁本來就會卸載首頁
  useEffect(() => { wakeApi() }, [])

  useEffect(() => {
    suggestionsMounted.current = true
    void loadSuggestions()
    void loadAuthState()
    return cancelSuggestionLoads
  }, [cancelSuggestionLoads, loadAuthState, loadSuggestions])

  // 退房是所有路徑的共同終點：leavePending 直到 settle 才解除，期間建房/加入維持禁用
  const doLeave = useCallback(() => {
    void leaveRooms()
      .catch(() => { /* 首頁維持 best-effort；下次進首頁再確認房籍。 */ })
      .finally(() => setLeavePending(false))
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
    // 再問一次就是同一份 dialog 連跳兩張。定案畫面的「完成」也會帶，但只在房籍只剩那間定案房時
    // （沒有後果可講，ADR-0007 2026-10-24 修訂，見 useLeaveDialog）。但旗標是掛在 history entry 上的，重整會還原、
    // 上一頁回到同一筆 entry 也會還原——不當場消耗掉，「退房→建新房→上一頁」就會靜默
    // 退掉新房，正好從這裡替本攔截要防的繞過開後門。replace 掉才是真的只用一次。
    if ((location.state as { leaveConfirmed?: boolean } | null)?.leaveConfirmed === true) {
      nav(location.pathname, { replace: true, state: null })
      doLeave()
      return
    }
    void fetchLeaveRooms().then(rooms => {
      if (rooms && rooms.length === 0) setLeavePending(false) // room_members 就是權威
      // 全是殘留房（ADR-0007 2026-10-01 修訂）才直接退：/api/leave 全退不挑房，
      // 混著一間還在進行的就得照舊整份問
      else if (rooms?.every(r => r.stale)) doLeave()
      else setLeaveTarget(rooms ? { kind: 'rooms', rooms } : { kind: 'unknown' })
    })
  }, [location, nav, doLeave])

  function confirmLeave() {
    setLeaveTarget(null)
    doLeave()
  }

  async function persistRoom(creatorUid: string, pos: DeparturePoint) {
    const { data, error } = await supabase.rpc('create_room', {
      p_lat: pos.lat, p_lng: pos.lng,
    })
    if (error) {
      setCreateError(CREATE_ROOM_MESSAGES[error.message] ?? error.message)
      return
    }
    await applyDefaultPrefs(data)
    saveLastDeparture(creatorUid, pos)
    saveRoomDeparture(data, pos)
    nav(`/room/${data}`)
  }

  // 建房一律「馬上出發」，用餐時間與地點進房後在 lobby 改。create_room 仍要座標，出發點依序取：
  // 已還原的上次出發點 → 點擊當下補讀（loadSuggestions 的還原是非同步的，可能還沒落地）→
  // 目前定位 → 都沒有才在卡片裡開選點。抓定位最久 LOCATE_LIMIT_MS，也算在 busy 裡
  async function createRoom() {
    setBusy(true)
    setCreateError('')
    try {
      const creatorUid = await getUid()
      if (!creatorUid) return
      let pos = departure ?? loadLastDeparture(creatorUid)
      if (!pos) {
        try {
          // 權限詢問擱著時 getCurrentPosition 不會結束（它的 timeout 不含等授權的時間）：
          // 不設總時限，「建立中」和共用 busy 的「加入」會一起卡住
          const coords = await Promise.race([getPosition(navigator.geolocation),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('定位逾時')), LOCATE_LIMIT_MS))])
          // label 同 LocationPicker 的「使用目前位置」
          pos = { ...coords, label: '目前位置' }
        } catch {
          setLocateFailed(true)
          return
        }
      }
      // 等定位時離開了首頁（例如點了足跡）：不建房，免得晚點把人拉進一間新房。
      // suggestionsMounted 只在卸載時設 false，等同頁面的掛載旗標
      if (!suggestionsMounted.current) return
      await persistRoom(creatorUid, pos)
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
          : error?.message?.includes('人數已滿') ? '聚餐人數已滿' : '找不到這場聚餐，或聚餐已開始')
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
          沒有它鍵盤使用者可以 tab 到「發起聚餐」按 Enter，繞過還沒決定的退房（Codex P2） */}
      <div className="min-h-screen" inert={!!leaveTarget}>
      <header className="mx-auto w-full max-w-md px-4 pt-4">
        {/* 字級特大時 320px 並排不下：按鈕組換到下一行並靠右，不撐出水平捲動 */}
        <div className="flex flex-wrap items-center justify-between gap-y-1">
          <div className="flex items-center gap-2">
            <Logo className="h-8 w-8" />
            {/* 320px 要和兩顆按鈕並排：手機 text-lg，sm 以上才放大 */}
            <span className="font-serif text-lg font-black tracking-[0.12em] whitespace-nowrap sm:text-xl">今天吃什麼</span>
          </div>
          {/* grow：同一行時吃滿標題右邊的空間（狀態文字照舊能排成一行），換行後佔滿整行、按鈕靠右 */}
          <div className="flex grow flex-col items-end gap-1">
            <div className="flex items-center gap-1 sm:gap-1.5">
              <ThemeMenu />
              <Link to="/history" className="btn btn-quiet min-h-11 px-2 text-sm sm:px-3">足跡</Link>
              {/* 登出走同一道 leavePending 閘門（比照建房/加入）：查房籍還在飛、或確認 dialog
                  開著時登出，App.tsx 的 auth listener 會卸載本頁，doLeave() 永遠不會執行，
                  伺服器端房籍留著——該使用者變成幽靈成員，條件與票繼續約束房間盤面。
                  閘門不會鎖死：fetchLeaveRooms 有逾時（查詢 5 秒、等飛行中退房另限 60 秒），逾時也會開出 dialog，
                  兩顆按鈕都會讓 leavePending settle（roomMembership.test.ts 釘住那條出口） */}
              {/* 320px 要塞外觀鈕＋足跡＋登出：手機只留圖示，「登出」仍是按鈕的可及名稱 */}
              <button className="btn btn-quiet min-h-11 min-w-11 px-3 text-sm" disabled={leavePending}
                onClick={() => supabase.auth.signOut()}>
                <LogOut className="h-4 w-4" />
                <span className="sr-only sm:not-sr-only">登出</span>
              </button>
            </div>
            {leavePending && (
              // w-0 min-w-full：寬度跟著按鈕欄，不拿自己的字寬撐按鈕欄。否則換行判斷會算進這行字，
              // 每次進首頁查房籍的那一下，320／360px 預設字級的按鈕就會掉到第二行
              <p role="status" className="w-0 min-w-full text-right text-xs text-fg-muted">
                正在確認聚餐狀態，確認後才能登出
              </p>
            )}
          </div>
        </div>
        <div className="double-rule mt-4" />
      </header>

      <main className="mx-auto w-full max-w-md space-y-4 p-4">
        <CustomWheel />
        <section className="card animate-rise space-y-4 p-5">
          <div aria-hidden="true" className="flex items-center gap-2.5 text-xs tracking-[0.3em] text-brand">
            本日聚餐
            <span className="h-px flex-1 bg-brand/30" />
          </div>
          <h1 className="text-3xl leading-tight font-black tracking-[0.04em]">開一場聚餐決策</h1>
          <p className="text-sm leading-relaxed text-fg-muted">
            發起聚餐後再設定用餐時間與地點，把邀請連結給大家，各自設好條件就能開始搜尋。
          </p>
          {authState === 'member' && locateFailed && <>
            <p role="status" className="text-sm text-fg-muted">抓不到目前位置，請選擇出發點</p>
            <LocationPicker value={departure} onChange={handleDepartureChange} />
          </>}
          {authState === 'guest' ? (
            <Link to="/auth?mode=register" className="btn btn-primary w-full">註冊後發起聚餐</Link>
          ) : authState === 'member' ? <button onClick={createRoom}
            disabled={busy || leavePending || (locateFailed && !departure)} className="btn btn-primary w-full">
            {busy && <Spinner className="h-5 w-5" />}
            {busy ? '發起中…' : '發起聚餐'}
          </button> : authState === 'error' ? (
            <div className="space-y-2">
              <p className="flex items-center gap-2 text-sm text-danger" role="alert">
                <Alert className="h-5 w-5 shrink-0" />
                無法確認帳號狀態，請重新檢查
              </p>
              <button type="button" className="btn btn-primary w-full" onClick={loadAuthState}>重新檢查</button>
            </div>
          ) : <p role="status" className="text-sm text-fg-muted">正在確認帳號狀態…</p>}
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
              onPaste={e => {
                const pasted = inviteCodeFromLink(e.clipboardData.getData('text'))
                if (!pasted) return
                e.preventDefault()
                setCode(pasted)
                setJoinError('')
              }}
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
              。要加入預設偏好嗎？之後發起聚餐會自動帶入。
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
                addDismissed(`prefs-suggest-dismissed:${myUserId}`, suggestion)
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
        // 「回到聚餐」是 button 不是 Link：React 的 autoFocus 只對表單控制項生效，
        // 焦點必須落在安全那顆，不能落在「退出聚餐」上。
        // 不給 onClose（Esc）：留在首頁又不決定會讓建房/加入永遠禁用，不是合法終態。
        return (
          <LeaveConfirm title="你還有進行中的聚餐"
            actions={<>
              {rooms.length === 1 && (
                <button type="button" autoFocus className="btn btn-primary w-full"
                  onClick={() => nav(`/room/${rooms[0].id}`)}>回到聚餐</button>
              )}
              {leaveTarget.kind === 'unknown' && (
                <button type="button" autoFocus className="btn btn-quiet w-full"
                  onClick={() => window.location.reload()}>重新整理再試</button>
              )}
              <button type="button" className="btn w-full bg-danger text-on-danger"
                onClick={confirmLeave}>退出聚餐</button>
            </>}>
            {leaveTarget.kind === 'unknown' && (
              <p className="text-sm text-fg-muted">
                你可能還有進行中的聚餐，但聚餐現況查不到（連線可能不穩），離開後的影響無法確認
                ——不確定就先重新整理再試，確定要走再按退出聚餐。
              </p>
            )}
            {rooms.length === 1 && (
              <p className="text-sm text-fg-muted">
                你回到首頁了，但你還有一場進行中的聚餐（{rooms[0].code}）。退出後果如下：
              </p>
            )}
            {multi && (
              <p className="text-sm text-fg-muted">
                你回到首頁了，但你還有 {rooms.length} 場進行中的聚餐，退出會一次全部退出：
              </p>
            )}
            {/* 多房時回房入口掛在各房區塊內，不替使用者猜要回哪一間（比照 HistoryPage） */}
            <LeaveRoomsList rooms={rooms} onReturn={id => nav(`/room/${id}`)} />
          </LeaveConfirm>
        )
      })()}
    </>
  )
}

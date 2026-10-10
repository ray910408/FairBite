import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMidnightRerender } from '../hooks/useMidnightRerender'
import { useRoom } from '../hooks/useRoom'
import {
  cancelShortlist, chooseLocation, confirmDraw, editConditions, pendingLeave, redrawRoom, startVoting, voteLocation,
  voteShortlist,
} from '../lib/api'
import { loadRoomDeparture, saveRoomDeparture, type DeparturePoint } from '../lib/departure'
import { isVetoDeadEnd } from '../lib/deadEnd'
import { EXPLORATION_OPTIONS } from '../lib/labels'
import { buildMealTimeISO, formatMealTime } from '../lib/mealTime'
import { isGoogleSourced } from '../lib/placesSource'
import { snapshotCandidates } from '../lib/probability'
import { fetchLeaveRooms, type LeaveTarget } from '../lib/roomMembership'
import {
  SHORTLIST_PICK_MIN, hasMyPick, keptPickCounts, membersBelowMin, pickCounts, shortlistOpen,
} from '../lib/shortlist'
import { supabase } from '../lib/supabase'
import type { Room } from '../lib/types'
import ConditionsForm from '../components/ConditionsForm'
import { LeaveConfirm, LeaveRoomsBody } from '../components/LeaveConfirm'
import CandidateList from '../components/CandidateList'
import Wheel from '../components/Wheel'
import ResultCard from '../components/ResultCard'
import RatingPrompt from '../components/RatingPrompt'
import RelocationPanel from '../components/RelocationPanel'
import ShortlistVotePanel from '../components/ShortlistVotePanel'
import { GuestRegistrationPrompt } from '../components/GuestRegistrationPrompt'
import { InviteQRCode } from '../components/InviteQRCode'
import { Alert, Check, Copy, Logo, Spinner } from '../components/icons'

const STEPS = [
  { key: 'lobby', label: '設定條件', numeral: '壹' },
  { key: 'candidates', label: '候選出爐', numeral: '貳' },
  { key: 'voting', label: '投票', numeral: '參' },
  { key: 'pending', label: '待確認', numeral: '肆' },
  { key: 'decided', label: '定案', numeral: '伍' },
] as const

const SEARCH_SLOW_STATUS_MS = 3000

// 菜單式狀態列：成員名……狀態。ready 與初選圈滿共用 ok 色
const MEMBER_STATUS = 'inline-flex items-center gap-1 whitespace-nowrap text-sm'

// 房內三組 segmented control：墨線框、選中反白（同首頁用餐時間）
const SEGMENTED = 'divide-x divide-rule rounded-btn border border-rule'
function segment(active: boolean) {
  return `min-h-11 text-sm font-semibold tracking-[0.1em] transition-colors duration-150 ${
    active ? 'bg-fg text-canvas' : 'text-fg enabled:hover:bg-brand-soft'}`
}

function Stepper({ status }: { status: Room['status'] }) {
  // relocating／shortlisting 不是獨立步驟：借用投票／候選出爐那格並改標籤
  const current = STEPS.findIndex(s => s.key === (
    status === 'relocating' ? 'voting' : status === 'shortlisting' ? 'candidates' : status))
  // 320px 寬：五格不畫連接線、靠 justify-between 撐開，字距縮到 gap-0.5 才放得下
  return (
    <ol className="flex items-center justify-between gap-1 text-xs">
      {STEPS.map((s, i) => (
        <li key={s.key} aria-current={i === current ? 'step' : undefined}
          className="flex items-center gap-0.5 whitespace-nowrap">
          {i < current ? <Check className="h-3.5 w-3.5 shrink-0 text-ok" />
            : <span aria-hidden="true" className={`font-serif ${i === current ? 'font-black text-brand' : 'text-fg-muted'}`}>
              {s.numeral}
            </span>}
          <span className={i === current ? 'font-bold text-brand underline decoration-2 underline-offset-[5px]'
            : 'text-fg-muted'}>
            {s.key === 'voting' && status === 'relocating' ? '換地點'
              : s.key === 'candidates' && status === 'shortlisting' ? '初選' : s.label}
          </span>
        </li>
      ))}
    </ol>
  )
}

// 初選中每位成員（含房主）的圈選進度；圈滿下限用 ok 樣式，比照「已準備」
function pickBadge(count: number) {
  const done = count >= SHORTLIST_PICK_MIN
  return (
    <span className={`${MEMBER_STATUS} ${done ? 'text-ok' : 'text-fg-muted'}`}>
      {done && <Check className="h-3.5 w-3.5 shrink-0" />}
      {done ? `已圈 ${count} 家` : `圈選中 ${count}/${SHORTLIST_PICK_MIN}`}
    </span>
  )
}

export default function RoomPage() {
  const { id = '' } = useParams()
  const nav = useNavigate()
  const { room, members, candidates, draw, locationVotes = [], shortlistVotes = [], shortlistPicks = [], myUserId,
    connected, notFound, loadError, refetch, toggleVote, togglePick, hasMyVote, ups, vetoesRemaining } = useRoom(id)
  const [spun, setSpun] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionWarning, setActionWarning] = useState('')
  const [copied, setCopied] = useState(false)
  const [editingCustom, setEditingCustom] = useState(false)
  const [draftHH, setDraftHH] = useState('')
  const [draftMM, setDraftMM] = useState('')
  // ref 管互斥（同步）、state 管 loading 畫面（非同步）——分工見 e2e 快速連點斷言
  const [searching, setSearching] = useState(false)
  const [startingVoting, setStartingVoting] = useState(false)
  // 退房確認（ADR-0007：回首頁＝離席）——新 state 一律接在最後，RoomPage.test.ts 依呼叫順序 mock useState
  const [leaveDialog, setLeaveDialog] = useState<LeaveTarget | null>(null)
  const [leaveChecking, setLeaveChecking] = useState(false)
  const [roomSettingsBlocked, setRoomSettingsBlocked] = useState(false)
  const [editingConditions, setEditingConditions] = useState(false)
  const [searchSlow, setSearchSlow] = useState(false)
  const [pendingAction, setPendingAction] = useState<'confirm' | 'redraw' | null>(null)
  const [relocationBusy, setRelocationBusy] = useState(false)
  const [isGuest, setIsGuest] = useState(false)
  // 初選表決／取消初選共用（兩者不會同時出現：表決只在 candidates、取消只在 shortlisting）
  const [shortlistBusy, setShortlistBusy] = useState(false)
  const leaveTriggerRef = useRef<HTMLAnchorElement>(null)
  // 房籍查詢自己的世代（比照 HistoryPage）：aria-busy 擋不住點擊，兩次點擊之間房籍
  // 還可能在別的分頁被改，只有最後一次點擊的回應能生效
  const leaveGen = useRef(0)
  const mealTimeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const pendingMealTime = useRef<{ generation: number; iso: string | null } | null>(null)
  const roomWriteChain = useRef(Promise.resolve())
  const roomWriteGeneration = useRef(0)
  const roomWriteQueued = useRef(0)
  const roomWriteFailures = useRef(new Set<keyof Pick<Room, 'exploration' | 'meal_time' | 'cuisine_filter'>>())
  const roomWritesValid = useRef(true)
  const mealTimeGeneration = useRef(0)
  const durableMealTimeGeneration = useRef(0)
  const durableMealTime = useRef<string | null>(room?.meal_time ?? null)
  const conditionsFlush = useRef<() => Promise<boolean>>(async () => true)
  const guestsReadyRef = useRef(true)
  const searchInFlight = useRef(false)
  const searchSlowTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const searchMounted = useRef(true)
  const searchGeneration = useRef(0)
  const searchAbort = useRef<AbortController | undefined>(undefined)
  const startVotingInFlight = useRef(false)
  const editConditionsInFlight = useRef(false)
  const pendingActionInFlight = useRef(false)
  const currentDraw = draw?.version === room?.draw_version ? draw : null
  const drawCandidates = currentDraw ? snapshotCandidates(candidates, currentDraw.probabilities) : []

  useEffect(() => {
    const d = room?.meal_time ? new Date(room.meal_time) : null
    setDraftHH(d ? String(d.getHours()).padStart(2, '0') : '')
    setDraftMM(d ? String(d.getMinutes()).padStart(2, '0') : '')
  }, [room?.meal_time])
  useEffect(() => {
    durableMealTime.current = room?.meal_time ?? null
  }, [room?.id, room?.meal_time])
  useEffect(() => {
    const mounted = searchMounted
    const generation = searchGeneration
    const abort = searchAbort
    const inFlight = searchInFlight
    const slowTimer = searchSlowTimer
    mounted.current = true
    return () => {
      mounted.current = false
      generation.current++
      abort.current?.abort()
      abort.current = undefined
      inFlight.current = false
      const timer = slowTimer.current
      slowTimer.current = undefined
      if (timer !== undefined) clearTimeout(timer)
    }
  }, [])
  useEffect(() => { setSpun(false) }, [draw?.version])
  useEffect(() => {
    const getUser = supabase.auth?.getUser?.bind(supabase.auth)
    if (getUser) void getUser().then(({ data }) => setIsGuest(data.user?.is_anonymous === true)).catch(() => {})
  }, [])
  useMidnightRerender() // 新 hook 一律接在最後：RoomPage.test.ts 依呼叫順序 mock
  if (!room) {
    if (loadError) return (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
        <Logo className="h-12 w-12 opacity-60" />
        <p className="text-fg-muted">房間載入失敗，請稍後再試</p>
        <button type="button" className="btn btn-primary px-6" onClick={() => { void refetch() }}>重試</button>
      </main>
    )
    return notFound ? (
      <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
        <Logo className="h-12 w-12 opacity-60" />
        <p className="text-fg-muted">找不到房間，或你不是成員</p>
        <Link to="/" className="btn btn-primary px-6">回首頁</Link>
      </main>
    ) : (
      <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-fg-muted">
        <Spinner className="h-7 w-7 text-brand" />
        <p className="text-sm">讀取房間…</p>
      </div>
    )
  }

  const me = members.find(m => m.user_id === myUserId)
  const isHost = room.host_id === myUserId
  const guestsNotReady = members.filter(m => m.user_id !== room.host_id && !m.ready).length
  const guestsReady = guestsNotReady === 0
  guestsReadyRef.current = guestsReady
  // 非房主看不到房主的按鈕：講清楚現在在等誰、輪到自己做什麼。
  // uid 還沒讀到時不知道是不是房主，先不講；候選全滅另有死路橫幅，不能再叫人等轉盤
  const guestHint = isHost || !me ? undefined : ({
    lobby: !me.ready ? '設好條件後，按最下方「我準備好了」'
      : guestsReady ? '已準備好，等房主開始搜尋' : `已準備好，還在等 ${guestsNotReady} 人`,
    candidates: '候選出爐了，等房主開始投票',
    voting: candidates.some(c => c.status === 'kept') ? '投完票後，等房主啟動轉盤' : undefined,
    pending: '等房主確認，或排除這家重轉',
  } as Partial<Record<Room['status'], string>>)[room.status]
  // 初選：圈選只算仍是 kept 的候選（同 server keptPicksSQL）
  const picksByMember = keptPickCounts(shortlistPicks, candidates)
  const shortlistUnfinished = membersBelowMin(members, picksByMember)

  function updateRoomSettingsGate() {
    setRoomSettingsBlocked(roomWriteQueued.current > 0 || pendingMealTime.current !== null || !roomWritesValid.current)
  }

  function restoreDurableMealTime() {
    const d = durableMealTime.current ? new Date(durableMealTime.current) : null
    setEditingCustom(d !== null)
    setDraftHH(d ? String(d.getHours()).padStart(2, '0') : '')
    setDraftMM(d ? String(d.getMinutes()).padStart(2, '0') : '')
  }

  function enqueueRoomWrite(generation: number, patch: Partial<Pick<Room, 'exploration' | 'meal_time' | 'cuisine_filter'>>,
    errorMessage: string, onLatestFailure?: () => void) {
    roomWriteQueued.current++
    updateRoomSettingsGate()
    const operation = roomWriteChain.current.then(async () => {
      let failed = false
      try {
        const { error, count } = await supabase.from('rooms')
          .update(patch, { count: 'exact' }).eq('id', room!.id)
        failed = !!error || count === 0
      } catch {
        failed = true
      }
      const fields = Object.keys(patch) as Array<keyof typeof patch>
      if (failed) {
        for (const field of fields) roomWriteFailures.current.add(field)
        roomWritesValid.current = false
        onLatestFailure?.()
        setActionError(errorMessage)
      } else {
        if ('meal_time' in patch && generation > durableMealTimeGeneration.current) {
          durableMealTimeGeneration.current = generation
          durableMealTime.current = patch.meal_time ?? null
          if (patch.meal_time === null) {
            setEditingCustom(false)
            setDraftHH('')
            setDraftMM('')
          }
        }
        for (const field of fields) roomWriteFailures.current.delete(field)
        roomWritesValid.current = roomWriteFailures.current.size === 0
        if (roomWritesValid.current) {
          setActionError('')
        }
      }
      return !failed
    })
    const settled = operation.then(result => {
      roomWriteQueued.current--
      updateRoomSettingsGate()
      return result
    })
    roomWriteChain.current = settled.then(() => undefined)
    return settled
  }

  function enqueuePendingMealTime() {
    clearTimeout(mealTimeTimer.current)
    mealTimeTimer.current = undefined
    const pending = pendingMealTime.current
    if (!pending) return roomWriteChain.current
    pendingMealTime.current = null
    return enqueueRoomWrite(pending.generation, { meal_time: pending.iso }, '用餐時間更新失敗', () => {
      if (pending.generation === mealTimeGeneration.current) restoreDurableMealTime()
    })
  }

  function saveRoomSetting(patch: Partial<Pick<Room, 'exploration' | 'cuisine_filter'>>, errorMessage: string) {
    void enqueuePendingMealTime()
    const generation = ++roomWriteGeneration.current
    setActionError('')
    return enqueueRoomWrite(generation, patch, errorMessage)
  }

  async function flushRoomWrites() {
    enqueuePendingMealTime()
    await roomWriteChain.current
    return roomWritesValid.current && roomWriteQueued.current === 0 && pendingMealTime.current === null
  }

  function cancelPendingMealTime() {
    clearTimeout(mealTimeTimer.current)
    mealTimeTimer.current = undefined
    pendingMealTime.current = null
    updateRoomSettingsGate()
  }

  function saveMealTime(iso: string | null) {
    setActionError('')
    cancelPendingMealTime()
    const generation = ++roomWriteGeneration.current
    mealTimeGeneration.current = generation
    pendingMealTime.current = { generation, iso }
    updateRoomSettingsGate()
    mealTimeTimer.current = setTimeout(() => {
      void enqueuePendingMealTime()
    }, 400)
  }

  function updateMealTime(hhmm: string) {
    setActionError('')
    const r = buildMealTimeISO(hhmm)
    if ('error' in r) { setActionError(r.error); return }
    saveMealTime(r.iso)
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room!.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setActionError('複製失敗，請手動記下邀請碼')
    }
  }

  // 投票規則（op 判定/連點鎖/本地鏡射）都在 useRoom；這裡只負責把錯誤接到畫面
  async function onToggleVote(restaurantId: string, kind: 'up' | 'veto') {
    setActionError('')
    const msg = await toggleVote(restaurantId, kind)
    if (msg) setActionError(msg) // D4：伺服器訊息直達（額度用盡/不在投票階段都有明確下一步）
  }

  // 圈選規則（op 判定/連點鎖/本地鏡射）同投票都在 useRoom
  async function onTogglePick(restaurantId: string) {
    setActionError('')
    const msg = await togglePick(restaurantId)
    if (msg) setActionError(msg)
  }

  // candidates 與 shortlisting 共用：初選未圈滿時伺服器回 409 原文
  async function onStartVoting() {
    if (startVotingInFlight.current) return
    startVotingInFlight.current = true
    setStartingVoting(true)
    setActionError('')
    const msg = await startVoting(room!.id)
      .catch(() => '開始投票失敗：無法連線到伺服器')
      .finally(() => { startVotingInFlight.current = false; setStartingVoting(false) })
    if (msg) setActionError(msg)
  }

  async function onShortlistVote(want: boolean) {
    if (shortlistBusy) return
    setShortlistBusy(true); setActionError('')
    try {
      const msg = await voteShortlist(room!.id, want, room!.search_version)
      if (msg) setActionError(msg)
      else await refetch()
    } catch { setActionError('初選表決失敗：無法連線到伺服器') }
    finally { setShortlistBusy(false) }
  }

  async function onCancelShortlist() {
    if (shortlistBusy) return
    if (!globalThis.confirm('取消初選會清除所有人的圈選，回到候選出爐。確定繼續？')) return
    setShortlistBusy(true); setActionError('')
    try {
      const msg = await cancelShortlist(room!.id)
      if (msg) setActionError(msg)
      else await refetch()
    } catch { setActionError('取消初選失敗：無法連線到伺服器') }
    finally { setShortlistBusy(false) }
  }

  async function onEditConditions() {
    if (editConditionsInFlight.current) return
    if (!globalThis.confirm('修改條件會清除目前候選，並請所有成員重新準備。確定繼續？')) return
    editConditionsInFlight.current = true
    setEditingConditions(true)
    setActionError('')
    try {
      const msg = await editConditions(room!.id)
      if (msg) {
        setActionError(msg)
        return
      }
      await refetch()
    } catch {
      setActionError('修改條件失敗：無法連線到伺服器')
    } finally {
      editConditionsInFlight.current = false
      setEditingConditions(false)
    }
  }

  async function onLocationVote(want: boolean) {
    if (relocationBusy) return
    setRelocationBusy(true); setActionError('')
    try {
      const msg = await voteLocation(room!.id, want, room!.search_version)
      if (msg) setActionError(msg)
      else await refetch()
    } catch { setActionError('改地點表決失敗：無法連線到伺服器') }
    finally { setRelocationBusy(false) }
  }

  async function onChooseLocation(point: DeparturePoint) {
    if (relocationBusy) return
    setRelocationBusy(true); setActionError('')
    try {
      // Relocating uses frozen conditions; its ConditionsForm is already unmounted.
      const [conditionsOK, roomSettingsOK] = await Promise.all([
        room!.status === 'lobby' ? conditionsFlush.current() : true,
        flushRoomWrites(),
      ])
      if (!conditionsOK || !roomSettingsOK) return
      const msg = await chooseLocation(room!.id, point.lat, point.lng, room!.search_version)
      if (msg) setActionError(msg)
      else {
        saveRoomDeparture(room!.id, point)
        await refetch()
      }
    } catch { setActionError('更新地點失敗：無法連線到伺服器') }
    finally { setRelocationBusy(false) }
  }

  function closeLeave() {
    setLeaveDialog(null)
    // 觸發元素不隨 dialog 卸載，但背景整塊帶著 inert：setLeaveDialog 不同步 flush，
    // 同一輪呼叫 focus() 時觸發元素仍在 inert 子樹內，瀏覽器直接忽略、焦點掉回 body。
    // 排到移除 inert 的那次 commit 之後才還原（比照 HistoryPage 的 onRated）。
    requestAnimationFrame(() => leaveTriggerRef.current?.focus())
  }

  // 一律攔下來當場查（比照 HistoryPage），不讀本頁任何本地狀態：
  // 1. useRoom 的 room 在 rooms 查詢失敗時會停在舊物件（useRoom.ts:46 只在 r.data 為真
  //    時 setRoom，失敗只亮 loadError）——lobby→candidates 期間 refresh 失敗或 Realtime
  //    斷線，拿過期 status 就會承諾「之後可用邀請碼重新加入」，而 join_room 早就不匹配。
  // 2. POST /api/leave 是全退不挑房，殘留房籍（leave 逾時後又建新房）也會一起退掉，
  //    只講當前這一間就是漏報。
  // 代價是多一次查詢與非同步開啟（aria-busy 回饋）；不可逆動作上正確性優先於即時感。
  async function askLeave(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    const request = ++leaveGen.current
    // 上一頁回到房內時首頁的退房可能還在飛：這裡等它落地，按鈕會無聲卡到 50 秒（冷啟動）。
    // 直接回首頁，由首頁 mount 等（比照 HistoryPage）
    if (pendingLeave()) {
      nav('/')
      return
    }
    setLeaveChecking(true)
    const rooms = await fetchLeaveRooms()
    if (request !== leaveGen.current) return // 更新的一次在跑，checking 由它負責關掉
    setLeaveChecking(false)
    if (rooms && rooms.length === 0) { // 房籍已消失（被踢／房已刪）：沒有後果可講
      nav('/')
      return
    }
    setLeaveDialog(rooms ? { kind: 'rooms', rooms } : { kind: 'unknown' })
  }

  return (
    <>
      {/* dialog 開著時整塊背景 inert：fixed 遮罩擋得住指標（elementFromPoint 實測），
          對 tab 順序毫無作用——沒有它鍵盤使用者可以 tab 到「開始搜尋餐廳」按 Enter（Codex P2） */}
      <div className="min-h-screen" inert={!!leaveDialog}>
      <header className="sticky top-0 z-20 bg-canvas/85 backdrop-blur">
        {/* 320px 放不下最長的印章（等待選新地點）時讓印章換行，不撐出水平捲動 */}
        <div className="mx-auto flex w-full max-w-lg flex-wrap items-center gap-x-2 gap-y-1 p-3 pb-2 sm:gap-x-3">
          {/* 回首頁＝離席（ADR-0007），代價不可逆——攔下導覽先查再確認 */}
          <Link to="/" aria-label="回首頁" ref={leaveTriggerRef}
            aria-busy={leaveChecking} onClick={askLeave}
            className="-ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
            <Logo className="h-8 w-8" />
          </Link>
          {/* 12 碼在 320px 塞不下 text-lg + 0.25em 字距，小螢幕縮小、sm 以上維持原樣 */}
          <button onClick={copyCode}
            className="btn btn-quiet min-h-11 gap-1.5 px-1.5 font-mono text-sm sm:gap-2 sm:px-3 sm:text-lg sm:tracking-[0.25em]">
            {room.code}
            {copied ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4 text-fg-muted" />}
          </button>
          <span className="sr-only" aria-live="polite">{copied ? '邀請碼已複製' : ''}</span>
          <Link to="/history" className="btn btn-quiet min-h-11 px-1.5 text-xs sm:px-2 sm:text-sm">足跡</Link>
          <span className="seal ml-auto text-xs min-[375px]:text-sm">
            {{ lobby: '等待中', candidates: '候選已出爐', shortlisting: '初選中', voting: '投票中', relocating: '等待選新地點', pending: '抽中待確認', decided: '已定案' }[room.status]}
          </span>
        </div>
        <div className="mx-auto w-full max-w-lg px-3">
          <Stepper status={room.status} />
          <div className="double-rule mt-3" />
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg space-y-4 p-4">
        {!connected && (
          <p role="status" className="banner bg-warn-soft text-warn">
            <Alert className="h-5 w-5 shrink-0" />
            <span>連線中斷，嘗試重連中… 畫面可能不是最新狀態</span>
          </p>
        )}

        {loadError && (
          <p role="alert" className="banner bg-danger-soft text-danger">
            <Alert className="h-5 w-5 shrink-0" />
            <span>部分資料載入失敗，畫面可能不完整</span>
            <button type="button" className="ml-auto shrink-0 font-semibold underline"
              onClick={() => { void refetch() }}>重試</button>
          </p>
        )}

        {actionError && (
          <p role="alert" className="banner bg-danger-soft whitespace-pre-line text-danger">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{actionError}</span>
          </p>
        )}
        {actionWarning && (
          <p role="status" className="banner bg-warn-soft text-warn">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{actionWarning}</span>
          </p>
        )}

        <section className="animate-rise">
          <h2 className="mb-1.5 text-[15px] font-bold">成員（{members.length}）</h2>
          <ul>
            {members.map(m => (
              <li key={m.user_id} className="flex items-baseline gap-1.5 py-1.5">
                <span className="min-w-0 truncate font-serif font-medium">
                  {m.profiles?.display_name ?? '成員'}
                </span>
                <span aria-hidden="true" className="leader" />
                {m.user_id === room.host_id && (
                  // 括號只給報讀器：印章裡只蓋「房主」兩字
                  <span className="seal px-1 py-0 text-xs">
                    <span className="sr-only">（</span>房主<span className="sr-only">）</span>
                  </span>
                )}
                {room.status === 'shortlisting' ? (
                  pickBadge(picksByMember[m.user_id] ?? 0)
                ) : m.user_id !== room.host_id && (
                  <span className={`${MEMBER_STATUS} ${m.ready ? 'text-ok' : 'text-fg-muted'}`}>
                    {m.ready && <Check className="h-3.5 w-3.5 shrink-0" />}
                    {m.ready ? '已準備' : '設定中'}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </section>
        {guestHint && <p role="status" className="banner bg-brand-soft text-brand-strong">{guestHint}</p>}

        {(room.status === 'voting' || room.status === 'relocating' || (room.status === 'lobby' && isHost)) && (
          <RelocationPanel key={room.id} isHost={isHost} status={room.status}
            wantChange={locationVotes.some(v => v.user_id === myUserId)}
            yesCount={locationVotes.length} memberCount={members.length} busy={relocationBusy}
            onVote={onLocationVote} onChoose={onChooseLocation} current={loadRoomDeparture(room.id)} />
        )}
        {room.status === 'lobby' && (
          <section className="card space-y-3">
            <h2 className="text-base font-semibold">邀請成員</h2>
            <InviteQRCode code={room.code} />
          </section>
        )}

        {(room.status === 'candidates' || room.status === 'shortlisting' || room.status === 'voting') && (
          <p className="text-xs text-fg-muted">
            探索檔位：{EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[1]}
            ・用餐時間：{formatMealTime(room.meal_time)}
          </p>
        )}
        {room.status === 'lobby' && (
          <section className="card animate-rise">
            <h2 className="mb-1 text-sm font-semibold text-fg-muted">探索檔位</h2>
            <p className="mb-3 text-xs text-fg-muted">
              {EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[2]}
              {!isHost && '（由房主設定）'}
            </p>
            {/* D14：冷啟動誠實說明 —— 檔位靠同席紀錄運作，沒紀錄前三檔等效 */}
            <p className="mb-3 text-xs text-fg-muted">
              檔位依成員的同席紀錄調整機率；大家開始用這裡抽餐廳後才會逐漸生效
            </p>
            <div className={`grid grid-cols-3 ${SEGMENTED}`}>
              {EXPLORATION_OPTIONS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={room.exploration === key}
                  disabled={!isHost || searching}
                  className={`${segment(room.exploration === key)} disabled:cursor-default`}
                  onClick={() => saveRoomSetting({ exploration: key }, '探索檔位更新失敗')}>
                  {label}
                </button>
              ))}
            </div>
          </section>
        )}
        {room.status === 'lobby' && (
          <section className="card animate-rise">
            <h2 className="mb-1 text-sm font-semibold text-fg-muted">用餐時間</h2>
            <p className="mb-3 text-xs text-fg-muted">
              {formatMealTime(room.meal_time)}
              {!isHost && '（由房主設定）'}
            </p>
            {isHost && (
              <div className="space-y-2">
                <div className={`grid grid-cols-2 ${SEGMENTED}`}>
                  <button type="button" aria-pressed={room.meal_time === null && !editingCustom}
                    disabled={searching}
                    className={segment(room.meal_time === null && !editingCustom)}
                    onClick={() => saveMealTime(null)}>
                    馬上出發
                  </button>
                  <button type="button" aria-pressed={room.meal_time !== null || editingCustom}
                    disabled={searching}
                    className={segment(room.meal_time !== null || editingCustom)}
                    onClick={() => {
                      cancelPendingMealTime()
                      setEditingCustom(true)
                    }}>
                    自訂時間
                  </button>
                </div>
                {(editingCustom || room.meal_time !== null) && (
                  <div className="flex items-center gap-2">
                    <select className="field flex-1" aria-label="用餐時間（時）"
                      disabled={searching}
                      value={draftHH}
                      onChange={e => {
                        const hh = e.target.value
                        setDraftHH(hh)
                        if (hh && draftMM) void updateMealTime(`${hh}:${draftMM}`)
                      }}>
                      <option value="" disabled>時</option>
                      {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')).map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    <span className="text-fg-muted">:</span>
                    <select className="field flex-1" aria-label="用餐時間（分）"
                      disabled={searching}
                      value={draftMM}
                      onChange={e => {
                        const mm = e.target.value
                        setDraftMM(mm)
                        if (draftHH && mm) void updateMealTime(`${draftHH}:${mm}`)
                      }}>
                      <option value="" disabled>分</option>
                      {Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0')).map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
        {room.status === 'lobby' && (
          <section className="card animate-rise">
            <h2 className="mb-1 text-sm font-semibold text-fg-muted">菜系過濾</h2>
            <p className="mb-3 text-xs text-fg-muted">
              開啟後只保留符合成員菜系偏好的店；大家都沒選菜系時不會作用
              {!isHost && '（由房主設定）'}
            </p>
            <div className={`grid grid-cols-2 ${SEGMENTED}`}>
              {([[false, '關閉'], [true, '開啟']] as const).map(([value, label]) => (
                <button key={label} type="button" aria-pressed={room.cuisine_filter === value}
                  disabled={!isHost || searching}
                  className={`${segment(room.cuisine_filter === value)} disabled:cursor-default`}
                  onClick={() => saveRoomSetting({ cuisine_filter: value }, '菜系過濾更新失敗')}>
                  {label}
                </button>
              ))}
            </div>
          </section>
        )}
        {room.status === 'lobby' && me && <ConditionsForm me={me} isHost={isHost} searchVersion={room.search_version} disabled={searching}
          onFlushAvailable={flush => { conditionsFlush.current = flush ?? (async () => false) }} />}
        {room.status === 'lobby' && isHost && (
          <button className="btn btn-primary w-full"
            disabled={searching || roomSettingsBlocked || !guestsReady} aria-busy={searching}
            onClick={async () => {
              if (searchInFlight.current || !guestsReadyRef.current) return
              searchInFlight.current = true
              const generation = ++searchGeneration.current
              const controller = new AbortController()
              searchAbort.current = controller
              const isCurrent = () => searchMounted.current &&
                searchGeneration.current === generation && !controller.signal.aborted
              setSearching(true)
              setActionError('')
              try {
                const [conditionsOK, roomSettingsOK] = await Promise.all([
                  conditionsFlush.current(),
                  flushRoomWrites(),
                ])
                if (!isCurrent() || !conditionsOK || !roomSettingsOK || !guestsReadyRef.current) return
                const { searchRoom } = await import('../lib/api')
                if (!isCurrent()) return
                const o = await searchRoom(room.id, {
                  signal: controller.signal,
                  onRequestStart: () => {
                    if (!isCurrent()) return
                    const slowTimer = setTimeout(() => {
                      if (searchSlowTimer.current === slowTimer && isCurrent()) setSearchSlow(true)
                    }, SEARCH_SLOW_STATUS_MS)
                    searchSlowTimer.current = slowTimer
                  },
                })
                if (!isCurrent()) return
                setActionError(o.error ?? '')
                setActionWarning(o.warning ?? '')
              } catch {
                if (!isCurrent()) return
                setActionError('搜尋失敗：無法連線到伺服器')
              } finally {
                const currentRequest = isCurrent()
                if (searchAbort.current === controller) {
                  searchAbort.current = undefined
                  searchInFlight.current = false
                }
                if (currentRequest) {
                  const timer = searchSlowTimer.current
                  searchSlowTimer.current = undefined
                  if (timer !== undefined) {
                    clearTimeout(timer)
                    setSearchSlow(false)
                  }
                  setSearching(false)
                }
              }
            }}>
            {searching ? <><Spinner className="h-5 w-5" />搜尋中…</>
              : guestsReady ? '開始搜尋餐廳' : `還有 ${guestsNotReady} 人還沒準備好`}
          </button>
        )}
        {searchSlow && (
          <p role="status" className="text-center text-sm text-fg-muted">
            搜尋仍在進行；首次使用可能需要約 15 秒。
          </p>
        )}
        {room.status === 'candidates' && (
          <>
            {/* 門檻開放時候選清單必然很長，表決放在清單前面才看得到 */}
            {shortlistOpen(candidates.filter(c => c.status === 'kept').length, members.length) && (
              <ShortlistVotePanel wantShortlist={shortlistVotes.some(v => v.user_id === myUserId)}
                yesCount={shortlistVotes.length} memberCount={members.length} busy={shortlistBusy}
                onVote={onShortlistVote} />
            )}
            <CandidateList rows={candidates} />
            {isHost && (
              <div className="grid grid-cols-2 gap-3">
                <button className="btn btn-secondary w-full" disabled={editingConditions || startingVoting}
                  aria-busy={editingConditions} onClick={onEditConditions}>
                  {editingConditions ? <><Spinner className="h-5 w-5" />處理中…</> : '修改條件'}
                </button>
                <button className="btn btn-primary w-full" disabled={startingVoting || editingConditions}
                  aria-busy={startingVoting} onClick={onStartVoting}>
                  {startingVoting ? <><Spinner className="h-5 w-5" />處理中…</> : '開始投票'}
                </button>
              </div>
            )}
          </>
        )}
        {room.status === 'shortlisting' && (
          <>
            <p className="text-sm text-fg-muted">
              全員圈滿 {SHORTLIST_PICK_MIN} 家後房主可以開始投票；沒人圈的店不進轉盤
            </p>
            <CandidateList rows={candidates} picking={{
              isPicked: rid => hasMyPick(shortlistPicks, myUserId, rid),
              counts: pickCounts(shortlistPicks),
              myCount: picksByMember[myUserId] ?? 0,
              onToggle: onTogglePick,
            }} />
            {isHost && (
              <div className="space-y-3">
                <div className="grid grid-cols-2 gap-3">
                  <button className="btn btn-secondary w-full"
                    disabled={editingConditions || startingVoting || shortlistBusy}
                    aria-busy={editingConditions} onClick={onEditConditions}>
                    {editingConditions ? <><Spinner className="h-5 w-5" />處理中…</> : '修改條件'}
                  </button>
                  <button className="btn btn-quiet w-full"
                    disabled={shortlistBusy || startingVoting || editingConditions}
                    aria-busy={shortlistBusy} onClick={onCancelShortlist}>
                    {shortlistBusy ? <><Spinner className="h-5 w-5" />處理中…</> : '取消初選'}
                  </button>
                </div>
                <button className="btn btn-primary w-full"
                  disabled={shortlistUnfinished > 0 || startingVoting || editingConditions || shortlistBusy}
                  aria-busy={startingVoting} onClick={onStartVoting}>
                  {startingVoting ? <><Spinner className="h-5 w-5" />處理中…</>
                    : shortlistUnfinished > 0 ? `還有 ${shortlistUnfinished} 人沒圈滿 ${SHORTLIST_PICK_MIN} 家`
                    : '開始投票'}
                </button>
              </div>
            )}
          </>
        )}
        {room.status === 'voting' && (
          <>
            <CandidateList rows={candidates}
              voting={{ hasMyVote, ups, vetoesRemaining, onToggle: onToggleVote }} />
            {candidates.some(c => c.status === 'kept') ? null : (
              // D16：「全否決」和「全打烊」是兩種死路——用結構化 exclusion_kinds 分辨（deadEnd.ts）
              <p role="status" className="banner bg-warn-soft text-warn">
                <Alert className="h-5 w-5 shrink-0" />
                <span>{isVetoDeadEnd(candidates)
                  ? '候選已全數被否決，需有人收回否決才能抽選'
                  : '候選已全數失效（可能都打烊了），請建立新房間重新搜尋'}</span>
              </p>
            )}
            {isHost && (
              <button className="btn btn-primary w-full"
                disabled={!candidates.some(c => c.status === 'kept')}
                onClick={() => {
                  setActionError('')
                  import('../lib/api').then(m => m.drawRoom(room.id))
                    .then(msg => setActionError(msg ?? ''))
                    .catch(() => setActionError('抽選失敗：無法連線到伺服器'))
                }}>
                啟動轉盤
              </button>
            )}
          </>
        )}
        {(room.status === 'pending' || room.status === 'decided') && draw && !currentDraw && (
          <p role="status" className="banner bg-brand-soft text-brand-strong">正在同步最新抽選結果…</p>
        )}
        {(room.status === 'pending' || room.status === 'decided') && currentDraw && (
          <div className="space-y-4">
            {!spun && currentDraw.probabilities[currentDraw.winner_restaurant_id] != null ? (
              <Wheel key={currentDraw.version} rows={drawCandidates} winnerId={currentDraw.winner_restaurant_id}
                onDone={() => setSpun(true)} />
            ) : (
              <>
                <ResultCard draw={currentDraw} candidates={drawCandidates} me={me}
                  confirmed={room.status === 'decided'} />
                {room.status === 'decided' && <RatingPrompt roomId={room.id} />}
                {room.status === 'decided' && isGuest && (
                  <GuestRegistrationPrompt userId={myUserId} roomId={room.id} open />
                )}
                {room.status === 'pending' && isHost && (
                  <div className="grid grid-cols-2 gap-3">
                    <button type="button" className="btn btn-secondary w-full"
                      disabled={pendingAction !== null} aria-busy={pendingAction === 'redraw'}
                      onClick={async () => {
                        if (pendingActionInFlight.current) return
                        pendingActionInFlight.current = true; setPendingAction('redraw'); setActionError('')
                        try {
                          const msg = await redrawRoom(room.id, currentDraw.version)
                            .catch(() => '重轉失敗：無法連線到伺服器')
                          if (msg) setActionError(msg)
                          else await refetch().catch(() => setActionError('重轉成功，但重新載入失敗，請重新整理頁面'))
                        } finally {
                          pendingActionInFlight.current = false; setPendingAction(null)
                        }
                      }}>
                      {pendingAction === 'redraw' ? <><Spinner className="h-5 w-5" />重轉中…</> : '排除這家並重轉'}
                    </button>
                    <button type="button" className="btn btn-primary w-full"
                      disabled={pendingAction !== null} aria-busy={pendingAction === 'confirm'}
                      onClick={async () => {
                        if (pendingActionInFlight.current) return
                        pendingActionInFlight.current = true; setPendingAction('confirm'); setActionError('')
                        try {
                          const msg = await confirmDraw(room.id, currentDraw.version)
                            .catch(() => '確認失敗：無法連線到伺服器')
                          if (msg) setActionError(msg)
                          else await refetch().catch(() => setActionError('確認成功，但重新載入失敗，請重新整理頁面'))
                        } finally {
                          pendingActionInFlight.current = false; setPendingAction(null)
                        }
                      }}>
                      {pendingAction === 'confirm' ? <><Spinner className="h-5 w-5" />確認中…</> : '確認就吃這家'}
                    </button>
                  </div>
                )}
              </>
            )}
            {candidates.some(c => c.status === 'kept' && isGoogleSourced(c.restaurants.source)) && (
              <p className="text-xs text-fg-muted">餐廳資料 Powered by Google</p>
            )}
            <p className="text-xs text-fg-muted">天氣資料 Open-Meteo.com（CC BY 4.0）</p>
          </div>
        )}
      </main>
      </div>

      {leaveDialog && LeaveConfirm({
        title: '離開房間？',
        onClose: closeLeave,
        actionsClassName: 'sm:flex-row', // 320px 直排、sm 以上並排——按鈕不壓縮成兩行字
        actions: (
          <>
            <button type="button" autoFocus className="btn btn-quiet w-full sm:flex-1"
              onClick={closeLeave}>
              取消
            </button>
            {/* 使用者在這裡已經看過後果：帶旗標過去讓 HomePage mount 直接退房，不再問第二次 */}
            <Link to="/" state={{ leaveConfirmed: true }}
              className="btn w-full bg-danger text-on-danger sm:flex-1">離開房間</Link>
          </>
        ),
        children: LeaveRoomsBody({ target: leaveDialog }),
      })}
    </>
  )
}

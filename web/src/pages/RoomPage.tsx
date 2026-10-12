import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMidnightRerender } from '../hooks/useMidnightRerender'
import { useRoom } from '../hooks/useRoom'
import { useRoomSettingsWrites } from '../hooks/useRoomSettingsWrites'
import {
  cancelShortlist, chooseLocation, confirmDraw, drawRoom, editConditions, pendingLeave, redrawRoom, searchRoom,
  startVoting, voteLocation, voteShortlist,
} from '../lib/api'
import { loadRoomDeparture, saveRoomDeparture, type DeparturePoint } from '../lib/departure'
import { isVetoDeadEnd } from '../lib/deadEnd'
import { buildInviteUrl } from '../lib/invite'
import { EXPLORATION_OPTIONS, ROOM_STATUS_LABEL } from '../lib/labels'
import { formatMealTime } from '../lib/mealTime'
import { loadSeenStage, saveSeenStage } from '../lib/seenStage'
import { fetchLeaveRooms, type LeaveTarget } from '../lib/roomMembership'
import {
  SHORTLIST_PICK_MIN, hasMyPick, keptPickCounts, membersBelowMin, pickCounts, shortlistOpen,
} from '../lib/shortlist'
import { supabase } from '../lib/supabase'
import type { Room } from '../lib/types'
import ConditionsForm from '../components/ConditionsForm'
import { LeaveConfirm, LeaveRoomsBody } from '../components/LeaveConfirm'
import CandidateList from '../components/CandidateList'
import DrawPanel from '../components/DrawPanel'
import { MemberList } from '../components/MemberList'
import RelocationPanel from '../components/RelocationPanel'
import { RoomHeader } from '../components/RoomHeader'
import { RoomSettings } from '../components/RoomSettings'
import ShortlistVotePanel from '../components/ShortlistVotePanel'
import { InviteQRCode } from '../components/InviteQRCode'
import { Alert, Chevron, Logo, Spinner } from '../components/icons'

const SEARCH_SLOW_STATUS_MS = 3000
const LIST_STAGES = new Set<string>(['candidates', 'shortlisting', 'voting'])
const EXHAUSTED_NOTICE = '候選已經全部排除（或都打烊了），回到準備階段：可以放寬條件或換地點後重新搜尋'

// 站內確認框（取代原生 confirm()）：清掉全房資料的動作先講後果
type ConfirmAsk = { title: string; body: string; confirmLabel: string; onConfirm: () => Promise<void> }

function scrollBehavior(): ScrollBehavior {
  return matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth'
}

// 動作的錯誤／提示只顯示在頁首：手機上按鈕在畫面下方時，訊息出現在畫面外，看起來像沒反應。
// 橫幅掛載時捲到看得見的地方（scroll-mt-36 讓它停在 sticky 標頭下：320px 時標頭約 124px，
// 加上浮現動畫起點的 8px 位移還有餘裕）。必須是模組層的穩定函式：
// inline ref callback 每次 render 都是新函式，React 會每次重跑，Realtime 一更新就把畫面拉回去。
// 一律捲到最上面那則：降級的 422 搜尋同時有錯誤和警告、同一次 commit 掛上，後跑的警告若捲自己，
// 會把上面該處理的錯誤推到標頭底下
function revealBanner(el: HTMLElement | null) {
  el?.parentElement?.querySelector('[data-action-banner]')?.scrollIntoView({ block: 'nearest', behavior: scrollBehavior() })
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
  const [pendingAction, setPendingAction] = useState<'draw' | 'confirm' | 'redraw' | null>(null)
  const [relocationBusy, setRelocationBusy] = useState(false)
  const [isGuest, setIsGuest] = useState(false)
  // 初選表決／取消初選共用（兩者不會同時出現：表決只在 candidates、取消只在 shortlisting）
  const [shortlistBusy, setShortlistBusy] = useState(false)
  const leaveTriggerRef = useRef<HTMLAnchorElement>(null)
  // 房籍查詢自己的世代（比照 HistoryPage）：aria-busy 擋不住點擊，兩次點擊之間房籍
  // 還可能在別的分頁被改，只有最後一次點擊的回應能生效
  const leaveGen = useRef(0)
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
  const shortlistInFlight = useRef(false)
  const relocationInFlight = useRef(false)
  const currentDraw = draw?.version === room?.draw_version ? draw : null

  useEffect(() => {
    const d = room?.meal_time ? new Date(room.meal_time) : null
    setDraftHH(d ? String(d.getHours()).padStart(2, '0') : '')
    setDraftMM(d ? String(d.getMinutes()).padStart(2, '0') : '')
  }, [room?.meal_time])
  // 本 hook 的 effect 必須排第二：RoomPage.test.ts 依呼叫順序取 effects[2] 當下面的搜尋 lifecycle
  const settings = useRoomSettingsWrites(room, {
    setActionError,
    setRoomSettingsBlocked,
    showMealTime: iso => {
      const d = iso ? new Date(iso) : null
      setEditingCustom(d !== null)
      setDraftHH(d ? String(d.getHours()).padStart(2, '0') : '')
      setDraftMM(d ? String(d.getMinutes()).padStart(2, '0') : '')
    },
  })
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
  const [confirmAsk, setConfirmAsk] = useState<ConfirmAsk | null>(null)
  const confirmTriggerRef = useRef<HTMLElement | null>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const stageHeadingRef = useRef<HTMLHeadingElement>(null)
  const shownStatus = useRef<Room['status'] | undefined>(undefined)
  const shownVersion = useRef<number | undefined>(undefined)
  const status = room?.status
  const searchVersion = room?.search_version
  // 換階段：舊階段的按鈕跟著整段卸載、焦點掉回 body，捲動也停在原位（常落在新階段中段）。
  // 捲回新階段開頭；焦點沒有別的去處時移到階段標題，螢幕閱讀器才會念出換到哪一步
  useEffect(() => {
    // 剛掛載（重整、重開分頁）時沒有上一個階段：拿這台裝置記下的來比，排光後才回來的成員也看得到原因
    const fresh = shownStatus.current === undefined
    const seen = fresh ? loadSeenStage(id) : undefined
    const prev = fresh ? seen?.status : shownStatus.current
    const prevVersion = fresh ? seen?.searchVersion : shownVersion.current
    shownStatus.current = status
    shownVersion.current = searchVersion
    if (!status) return
    saveSeenStage(id, status, searchVersion)
    if (!prev || prev === status) return
    // pending 回 lobby 只有一條路：重轉／確認時候選排光（pending.go resetExhaustedBatch），全房都要知道為什麼。
    // 看到的上一個階段可能落後好幾步（剛載入時記下的、或手機鎖屏喚醒後 Realtime 一次補上的：排光後
    // 又搜尋、修改條件才回 lobby）：search_version 每次進 lobby 和換地點各 +1、搜尋不加，
    // 剛好 +1 才代表最後一次回 lobby 是排光。
    // 換到別的階段就收掉這則（只收這則，搜尋的快取警告不動）：成員那邊沒有別的動作會清 actionWarning
    const exhausted = prev === 'pending' && status === 'lobby' && searchVersion === (prevVersion ?? NaN) + 1
    setActionWarning(w => exhausted ? EXHAUSTED_NOTICE : w === EXHAUSTED_NOTICE ? '' : w)
    setConfirmAsk(null) // 開框時看到的後果已經不是現在這一步了
    if (fresh) return // 剛載入的頁面只補說明：使用者沒按任何東西，不捲到階段開頭、不搶焦點
    const stage = stageRef.current
    if (!stage) return
    // 候選出爐／初選／投票之間是同一份清單換按鈕：別人推進階段時不拉走正在讀第幾家的人
    const sameList = LIST_STAGES.has(prev) && LIST_STAGES.has(status)
    // 量 sticky 標頭的實際底緣（320px 時印章會換行、標頭變高），不靠固定的 scroll-margin
    const hidden = stage.getBoundingClientRect().top - (document.querySelector('header')?.getBoundingClientRect().bottom ?? 0)
    // 留 16px（同 main 的 p-4），不貼著標頭的雙線
    if (!sameList && hidden < 0) scrollBy({ top: hidden - 16, behavior: scrollBehavior() })
    // 排到 rAF 才看焦點：上面關掉的確認框要等下一次 commit 才卸載、背景也那時才解除 inert，
    // 同步檢查時焦點還在框裡，卸載後掉回 body 就沒人接手
    requestAnimationFrame(() => {
      if (document.activeElement === document.body) stageHeadingRef.current?.focus({ preventScroll: true })
    })
  }, [status, searchVersion, id])
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
        {/* 背景分頁 token 過期且刷新失敗時，查詢會以 anon 身分送出而查無列；給一條不必離房的復原路 */}
        <button type="button" className="btn btn-quiet px-6" onClick={() => { void refetch() }}>重試</button>
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
  // uid 還沒讀到時不知道是不是房主，先不講；候選全滅另有死路橫幅，不能再叫人等轉盤；
  // 初選表決開放時成員自己有事可做，不能只叫人等
  const keptCount = candidates.filter(c => c.status === 'kept').length
  const guestHint = isHost || !me ? undefined : ({
    lobby: !me.ready ? '設好條件後，按最下方「我準備好了」'
      : guestsReady ? '已準備好，等房主開始搜尋' : `已準備好，還在等 ${guestsNotReady} 人`,
    candidates: shortlistOpen(keptCount, members.length)
      ? '候選很多：可以先表決要不要初選，之後等房主開始投票' : '候選出爐了，等房主開始投票',
    voting: keptCount > 0 ? '投完票後，等房主啟動轉盤' : undefined,
    pending: '等房主確認，或排除這家重轉',
  } as Partial<Record<Room['status'], string>>)[room.status]
  // 初選：圈選只算仍是 kept 的候選（同 server keptPicksSQL）
  const picksByMember = keptPickCounts(shortlistPicks, candidates)
  const shortlistUnfinished = membersBelowMin(members, picksByMember)

  // 複製連結而非 12 碼：收到碼的人得先註冊，/join/:code 連結才能讓訪客直接入房
  async function copyInvite() {
    try {
      await navigator.clipboard.writeText(buildInviteUrl(room!.code))
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

  async function onSearch() {
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
        settings.flushRoomWrites(),
      ])
      if (!isCurrent() || !conditionsOK || !roomSettingsOK || !guestsReadyRef.current) return
      const o = await searchRoom(room!.id, {
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
  }

  // 房間動作的共用流程。ref 鎖保證同一瞬間的連點只送一次（busy state 只管畫面：要等重繪才生效，
  // aria-busy 也擋不住點擊）。send 回傳伺服器訊息、成功回 null；前置步驟沒過、沒送出就回 false
  // （不顯示錯誤、不 refetch）。成功後等 refetch 完成才解鎖：否則 Realtime 到之前按鈕又能按，第二下回 409
  async function runAction(inFlight: { current: boolean }, setBusy: (busy: boolean) => void, label: string,
    send: () => Promise<string | null | false>) {
    if (inFlight.current) return
    inFlight.current = true
    setBusy(true)
    setActionError('')
    try {
      // try/await 而非 send().catch：send 同步拋錯（例如 room! 為 null）也要接到
      let msg: string | null | false
      try {
        msg = await send()
      } catch {
        msg = `${label}失敗：無法連線到伺服器`
      }
      if (msg === false) return
      if (msg) {
        setActionError(msg)
        return
      }
      // 動作已經成功：重新載入失敗不能說成「無法連線」
      try {
        await refetch()
      } catch {
        setActionError(`${label}成功，但重新載入失敗，請重新整理頁面`)
      }
    } finally {
      inFlight.current = false
      setBusy(false)
    }
  }

  // candidates 與 shortlisting 共用：初選未圈滿時伺服器回 409 原文
  function onStartVoting() {
    return runAction(startVotingInFlight, setStartingVoting, '開始投票', () => startVoting(room!.id))
  }

  function onShortlistVote(want: boolean) {
    return runAction(shortlistInFlight, setShortlistBusy, '初選表決',
      () => voteShortlist(room!.id, want, room!.search_version))
  }

  function askConfirm(e: React.MouseEvent<HTMLElement>, ask: ConfirmAsk) {
    confirmTriggerRef.current = e.currentTarget
    setConfirmAsk(ask)
  }

  function closeConfirm() {
    setConfirmAsk(null)
    // 同 closeLeave：背景 inert 要等這次 commit 移除，焦點才回得去觸發的按鈕
    requestAnimationFrame(() => confirmTriggerRef.current?.focus())
  }

  function askCancelShortlist(e: React.MouseEvent<HTMLElement>) {
    if (shortlistInFlight.current) return
    askConfirm(e, { title: '取消初選？', body: '取消初選會清除所有人的圈選，回到候選出爐。',
      confirmLabel: '清除圈選', onConfirm: onCancelShortlist })
  }

  function onCancelShortlist() {
    return runAction(shortlistInFlight, setShortlistBusy, '取消初選', () => cancelShortlist(room!.id))
  }

  function askEditConditions(e: React.MouseEvent<HTMLElement>) {
    if (editConditionsInFlight.current) return
    askConfirm(e, { title: '修改條件？', body: '修改條件會清除目前候選，並請所有成員重新準備。',
      confirmLabel: '清除候選並修改', onConfirm: onEditConditions })
  }

  function onEditConditions() {
    return runAction(editConditionsInFlight, setEditingConditions, '修改條件', () => editConditions(room!.id))
  }

  function onLocationVote(want: boolean) {
    return runAction(relocationInFlight, setRelocationBusy, '改地點表決',
      () => voteLocation(room!.id, want, room!.search_version))
  }

  function onChooseLocation(point: DeparturePoint) {
    return runAction(relocationInFlight, setRelocationBusy, '更新地點', async () => {
      // Relocating uses frozen conditions; its ConditionsForm is already unmounted.
      const [conditionsOK, roomSettingsOK] = await Promise.all([
        room!.status === 'lobby' ? conditionsFlush.current() : true,
        settings.flushRoomWrites(),
      ])
      if (!conditionsOK || !roomSettingsOK) return false
      const msg = await chooseLocation(room!.id, point.lat, point.lng, room!.search_version)
      if (!msg) saveRoomDeparture(room!.id, point)
      return msg
    })
  }

  // 抽選與抽中待確認的兩個房主動作共用一把鎖
  function onDraw() {
    return runAction(pendingActionInFlight, busy => setPendingAction(busy ? 'draw' : null), '抽選',
      () => drawRoom(room!.id))
  }

  function onRedraw() {
    return runAction(pendingActionInFlight, busy => setPendingAction(busy ? 'redraw' : null), '重轉',
      () => redrawRoom(room!.id, currentDraw!.version))
  }

  function onConfirmDraw() {
    return runAction(pendingActionInFlight, busy => setPendingAction(busy ? 'confirm' : null), '確認',
      () => confirmDraw(room!.id, currentDraw!.version))
  }

  function closeLeave() {
    setLeaveDialog(null)
    // 觸發元素不隨 dialog 卸載，但背景整塊帶著 inert：setLeaveDialog 不同步 flush，
    // 同一輪呼叫 focus() 時觸發元素仍在 inert 子樹內，瀏覽器直接忽略、焦點掉回 body。
    // 排到移除 inert 的那次 commit 之後才還原（比照 HistoryPage 的 onRated）。
    requestAnimationFrame(() => leaveTriggerRef.current?.focus())
  }

  // 一律攔下來當場查（比照 HistoryPage），不讀本頁任何本地狀態：
  // 1. useRoom 的 room 在 rooms 查詢失敗時會停在舊物件（useRoom 的 refetch 只在查到列時更新 room、
  //    查無列才清成 null，暫時性錯誤只亮 loadError）——lobby→candidates 期間 refresh 失敗或 Realtime
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
    setConfirmAsk(null) // 查房籍期間背景還沒 inert，可能先開了確認框：兩個 dialog 不能疊在一起
    setLeaveDialog(rooms ? { kind: 'rooms', rooms } : { kind: 'unknown' })
  }

  return (
    <>
      {/* dialog 開著時整塊背景 inert：fixed 遮罩擋得住指標（elementFromPoint 實測），
          對 tab 順序毫無作用——沒有它鍵盤使用者可以 tab 到「開始搜尋餐廳」按 Enter（Codex P2） */}
      <div className="min-h-screen" inert={!!leaveDialog || !!confirmAsk}>
      {RoomHeader({ room, copied, onCopy: copyInvite, leaveChecking, onLeave: askLeave, leaveTriggerRef })}

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

        {/* key：換一則訊息就重新掛載，revealBanner 與浮現動畫才會再跑一次 */}
        {actionError && (
          <p key={actionError} ref={revealBanner} data-action-banner role="alert"
            className="banner animate-rise scroll-mt-36 bg-danger-soft whitespace-pre-line text-danger">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{actionError}</span>
          </p>
        )}
        {actionWarning && (
          <p key={actionWarning} ref={revealBanner} data-action-banner role="status"
            className="banner animate-rise scroll-mt-36 bg-warn-soft text-warn">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{actionWarning}</span>
          </p>
        )}

        {MemberList({ room, members, picksByMember })}
        {guestHint && <p role="status" className="banner bg-brand-soft text-brand-strong">{guestHint}</p>}

        {/* 階段區塊：key 讓換階段時整段重新掛載並淡入（候選逐行浮現也跟著重播）。只淡入不位移：
            換階段 effect 量的是它的位置，帶著 translateY 量會少捲 8px、開頭被標頭蓋住。
            pending→decided 共用一段：結果卡不重掛，只由 ResultCard 換印章 */}
        <div key={room.status === 'decided' ? 'pending' : room.status} ref={stageRef}
          className="animate-fade space-y-4">
        <h1 ref={stageHeadingRef} tabIndex={-1} className="sr-only">
          目前階段：{ROOM_STATUS_LABEL[room.status]}
        </h1>
        {(room.status === 'voting' || room.status === 'relocating' || (room.status === 'lobby' && isHost)) && (
          <RelocationPanel key={room.id} isHost={isHost} status={room.status}
            wantChange={locationVotes.some(v => v.user_id === myUserId)}
            yesCount={locationVotes.length} memberCount={members.length} busy={relocationBusy}
            onVote={onLocationVote} onChoose={onChooseLocation} current={loadRoomDeparture(room.id)} />
        )}
        {room.status === 'lobby' && (isHost ? (
          <section className="card space-y-3">
            <h2 className="text-base font-semibold">邀請成員</h2>
            <InviteQRCode code={room.code} />
          </section>
        ) : (
          // 非房主不是主要邀請人：收起來，自己的條件不必捲過整張 QR 卡
          <details className="card py-0">
            <summary className="flex min-h-12 list-none items-center gap-2 font-serif text-base font-semibold [&::-webkit-details-marker]:hidden">
              <Chevron className="disclosure-chevron h-4 w-4" />
              邀請其他人加入
            </summary>
            <div className="pb-4"><InviteQRCode code={room.code} /></div>
          </details>
        ))}

        {(room.status === 'candidates' || room.status === 'shortlisting' || room.status === 'voting') && (
          <p className="text-xs text-fg-muted">
            探索檔位：{EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[1]}
            ・用餐時間：{formatMealTime(room.meal_time)}
          </p>
        )}
        {room.status === 'lobby' && RoomSettings({ room, isHost, searching, settings,
          editingCustom, setEditingCustom, draftHH, setDraftHH, draftMM, setDraftMM })}
        {room.status === 'lobby' && me && <ConditionsForm me={me} isHost={isHost} searchVersion={room.search_version} disabled={searching}
          onFlushAvailable={flush => { conditionsFlush.current = flush ?? (async () => false) }} />}
        {room.status === 'lobby' && isHost && (
          <button className="btn btn-primary w-full"
            disabled={searching || roomSettingsBlocked || !guestsReady} aria-busy={searching}
            onClick={onSearch}>
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
            {shortlistOpen(keptCount, members.length) && (
              <ShortlistVotePanel wantShortlist={shortlistVotes.some(v => v.user_id === myUserId)}
                yesCount={shortlistVotes.length} memberCount={members.length} busy={shortlistBusy}
                onVote={onShortlistVote} />
            )}
            <CandidateList rows={candidates} />
            {isHost && (
              <div className="grid grid-cols-2 gap-3">
                <button className="btn btn-secondary w-full" disabled={editingConditions || startingVoting}
                  aria-busy={editingConditions} onClick={askEditConditions}>
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
                    aria-busy={editingConditions} onClick={askEditConditions}>
                    {editingConditions ? <><Spinner className="h-5 w-5" />處理中…</> : '修改條件'}
                  </button>
                  <button className="btn btn-quiet w-full"
                    disabled={shortlistBusy || startingVoting || editingConditions}
                    aria-busy={shortlistBusy} onClick={askCancelShortlist}>
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
            {keptCount > 0 ? null : (
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
                disabled={keptCount === 0 || pendingAction !== null}
                aria-busy={pendingAction === 'draw'} onClick={onDraw}>
                {pendingAction === 'draw' ? <><Spinner className="h-5 w-5" />抽選中…</> : '啟動轉盤'}
              </button>
            )}
          </>
        )}
        {(room.status === 'pending' || room.status === 'decided') && draw && !currentDraw && (
          <p role="status" className="banner bg-brand-soft text-brand-strong">正在同步最新抽選結果…</p>
        )}
        {(room.status === 'pending' || room.status === 'decided') && currentDraw && (
          <DrawPanel room={room} draw={currentDraw} candidates={candidates} spun={spun} onSpun={() => setSpun(true)}
            me={me} myUserId={myUserId} isHost={isHost} isGuest={isGuest}
            pendingAction={pendingAction} lastCandidate={keptCount <= 1} onConfirm={onConfirmDraw}
            // 只剩這一家時重轉必然排光候選、全房回準備階段：先講清楚再送
            onRedraw={keptCount > 1 ? onRedraw : e => askConfirm(e, { title: '這是最後一家候選',
              body: '排除後就沒有候選了：全房會回到準備階段，要調整條件或換地點後重新搜尋。',
              confirmLabel: '排除並回到準備階段', onConfirm: onRedraw })} />
        )}
        </div>
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
      {confirmAsk && LeaveConfirm({
        title: confirmAsk.title,
        onClose: closeConfirm,
        actionsClassName: 'sm:flex-row',
        actions: (
          <>
            <button type="button" autoFocus className="btn btn-quiet w-full sm:flex-1" onClick={closeConfirm}>
              取消
            </button>
            <button type="button" className="btn w-full bg-danger text-on-danger sm:flex-1"
              onClick={() => { closeConfirm(); void confirmAsk.onConfirm() }}>
              {confirmAsk.confirmLabel}
            </button>
          </>
        ),
        children: <p className="text-sm text-fg-muted">{confirmAsk.body}</p>,
      })}
    </>
  )
}

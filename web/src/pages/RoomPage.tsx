import { useEffect, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useMidnightRerender } from '../hooks/useMidnightRerender'
import { useRoom } from '../hooks/useRoom'
import { useRoomSettingsWrites } from '../hooks/useRoomSettingsWrites'
import {
  cancelShortlist, chooseLocation, confirmDraw, drawRoom, editConditions, pendingLeave, redrawRoom, startVoting,
  voteLocation, voteShortlist,
} from '../lib/api'
import { loadRoomDeparture, saveRoomDeparture, type DeparturePoint } from '../lib/departure'
import { isVetoDeadEnd } from '../lib/deadEnd'
import { EXPLORATION_OPTIONS } from '../lib/labels'
import { formatMealTime } from '../lib/mealTime'
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
import { Alert, Logo, Spinner } from '../components/icons'

const SEARCH_SLOW_STATUS_MS = 3000

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
      const { searchRoom } = await import('../lib/api')
      if (!isCurrent()) return
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

  // candidates 與 shortlisting 共用：初選未圈滿時伺服器回 409 原文
  async function onStartVoting() {
    if (startVotingInFlight.current) return
    startVotingInFlight.current = true
    setStartingVoting(true)
    setActionError('')
    // 成功後等 refetch 完成才解鎖：否則 Realtime 到之前按鈕又能按，第二下回 409
    try {
      const msg = await startVoting(room!.id)
        .catch(() => '開始投票失敗：無法連線到伺服器')
      if (msg) setActionError(msg)
      else await refetch().catch(() => setActionError('已開始投票，但重新載入失敗，請重新整理頁面'))
    } finally {
      startVotingInFlight.current = false; setStartingVoting(false)
    }
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
        settings.flushRoomWrites(),
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

  // 抽選與抽中待確認的兩個房主動作共用一把鎖：成功後等 refetch 完成才解除 busy
  async function onDraw() {
    if (pendingActionInFlight.current) return
    pendingActionInFlight.current = true; setPendingAction('draw'); setActionError('')
    try {
      const msg = await drawRoom(room!.id)
        .catch(() => '抽選失敗：無法連線到伺服器')
      if (msg) setActionError(msg)
      else await refetch().catch(() => setActionError('抽選成功，但重新載入失敗，請重新整理頁面'))
    } finally {
      pendingActionInFlight.current = false; setPendingAction(null)
    }
  }

  async function onRedraw() {
    if (pendingActionInFlight.current) return
    pendingActionInFlight.current = true; setPendingAction('redraw'); setActionError('')
    try {
      const msg = await redrawRoom(room!.id, currentDraw!.version)
        .catch(() => '重轉失敗：無法連線到伺服器')
      if (msg) setActionError(msg)
      else await refetch().catch(() => setActionError('重轉成功，但重新載入失敗，請重新整理頁面'))
    } finally {
      pendingActionInFlight.current = false; setPendingAction(null)
    }
  }

  async function onConfirmDraw() {
    if (pendingActionInFlight.current) return
    pendingActionInFlight.current = true; setPendingAction('confirm'); setActionError('')
    try {
      const msg = await confirmDraw(room!.id, currentDraw!.version)
        .catch(() => '確認失敗：無法連線到伺服器')
      if (msg) setActionError(msg)
      else await refetch().catch(() => setActionError('確認成功，但重新載入失敗，請重新整理頁面'))
    } finally {
      pendingActionInFlight.current = false; setPendingAction(null)
    }
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
      {RoomHeader({ room, copied, onCopy: copyCode, leaveChecking, onLeave: askLeave, leaveTriggerRef })}

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

        {MemberList({ room, members, picksByMember })}
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
                disabled={!candidates.some(c => c.status === 'kept') || pendingAction !== null}
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
            pendingAction={pendingAction} onRedraw={onRedraw} onConfirm={onConfirmDraw} />
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

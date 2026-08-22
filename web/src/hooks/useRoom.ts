import { useCallback, useEffect, useRef, useState } from 'react'
import { voteRoom } from '../lib/api'
import { classifyRoomLoad } from '../lib/roomLoad'
import { supabase } from '../lib/supabase'
import type { CandidateRow, DrawRow, MemberRow, Room, VoteRow } from '../lib/types'
import { getUid } from '../lib/uid'
import { VETO_QUOTA, applyVoteMirror, hasMyVote, myVetoCount, upCounts } from '../lib/votes'

export function useRoom(roomId: string) {
  const [room, setRoom] = useState<Room | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [candidates, setCandidates] = useState<CandidateRow[]>([])
  const [draw, setDraw] = useState<DrawRow | null>(null)
  const [votes, setVotes] = useState<VoteRow[]>([])
  const [myUserId, setMyUserId] = useState('')
  const [connected, setConnected] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const refetchGen = useRef(0)

  const refetch = useCallback(async () => {
    const gen = ++refetchGen.current
    const [r, m, c, d, v] = await Promise.all([
      // 欄位得寫明：select('*') 會展開成全欄位，撞上 0015 的欄級 grant（center_* 只給
      // service role）會整包 permission denied
      supabase.from('rooms')
        .select('id, code, host_id, status, exploration, meal_time, cuisine_filter').eq('id', roomId).single(),
      supabase.from('room_members').select('*, profiles(display_name)').eq('room_id', roomId),
      supabase.from('room_candidates')
        .select('*, restaurants(name, lat, lng, place_id, source)').eq('room_id', roomId)
        .order('restaurant_id'),
      supabase.from('draws').select('*').eq('room_id', roomId).maybeSingle(),
      supabase.from('votes').select('*').eq('room_id', roomId),
    ])
    if (gen !== refetchGen.current) return // 有更新一輪在跑，這輪結果作廢
    // 讀不到房間要讓 UI 停止無限「載入中」；DB/網路錯誤與查無列分開呈現（QA ISSUE-002）
    // 任一查詢失敗都算 loadError；失敗的資料集不覆寫既有 state。
    const state = classifyRoomLoad(r.data, r.error)
    const siblingError = [m, c, d, v].some(x => x.error)
    setNotFound(state === 'not-found')
    setLoadError(state === 'error' || siblingError)
    if (r.data) setRoom(r.data as Room)
    if (!m.error) setMembers((m.data ?? []) as MemberRow[])
    if (!c.error) setCandidates((c.data ?? []) as CandidateRow[])
    if (!d.error) setDraw((d.data ?? null) as DrawRow | null)
    if (!v.error) setVotes((v.data ?? []) as VoteRow[])
  }, [roomId])

  useEffect(() => {
    getUid().then(uid => setMyUserId(uid ?? ''))
    refetch()
    // ponytail: 任何相關表變更就整包重抓，P1 資料量小；量大再改增量更新
    const tables = [
      { table: 'rooms', filter: `id=eq.${roomId}` },
      { table: 'room_members', filter: `room_id=eq.${roomId}` },
      { table: 'room_candidates', filter: `room_id=eq.${roomId}` },
      { table: 'draws', filter: `room_id=eq.${roomId}` },
      { table: 'votes', filter: `room_id=eq.${roomId}` },
    ]
    // roomId/refetch 變動會重跑本 effect：舊 channel 的 CLOSED 會晚於新 channel 的
    // SUBSCRIBED 抵達，沒有 live 旗標就會把已連線的狀態蓋回「斷線」
    let live = true
    let refetchTimer: ReturnType<typeof setTimeout> | undefined
    const scheduleRefetch = () => {
      clearTimeout(refetchTimer)
      refetchTimer = setTimeout(refetch, 150)
    }
    let ch = supabase.channel(`room-${roomId}`)
    for (const t of tables) {
      ch = ch.on('postgres_changes',
        { event: '*', schema: 'public', table: t.table, filter: t.filter }, scheduleRefetch)
    }
    // 斷線不能靜默：非 SUBSCRIBED 顯示橫幅，恢復時整包重拉補上漏掉的事件。
    // 首次 SUBSCRIBED 的 refetch 與 mount refetch 重疊是刻意的：補訂閱生效前的
    // 事件空窗（QA ISSUE-006 判定不修，代價是每次進房多一輪查詢）。
    ch.subscribe(status => {
      if (!live) return
      if (status === 'SUBSCRIBED') {
        setConnected(true)
        refetch()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setConnected(false)
      }
    })
    return () => {
      live = false
      clearTimeout(refetchTimer)
      supabase.removeChannel(ch)
    }
  }, [roomId, refetch])

  useEffect(() => {
    if (room?.status !== 'lobby') return
    let cancelled = false
    let timer: ReturnType<typeof setTimeout>
    const poll = async () => {
      await refetch().catch(() => undefined)
      if (!cancelled) timer = setTimeout(poll, 5_000)
    }
    timer = setTimeout(poll, 5_000)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [room?.status, refetch])

  const voteInFlight = useRef(false)
  // 投票唯一入口：算 op、打 API、成功才做本地鏡射；失敗回伺服器訊息字串給呼叫端顯示
  async function toggleVote(restaurantId: string, kind: 'up' | 'veto'): Promise<string | null> {
    if (voteInFlight.current) return null // D6：連點鎖 —— 慢網路下不重送、不閃假錯誤
    voteInFlight.current = true
    const op = hasMyVote(votes, myUserId, restaurantId, kind) ? 'retract' : 'cast'
    const msg = await voteRoom(roomId, restaurantId, kind, op)
      .catch(() => '投票失敗：無法連線到伺服器')
    voteInFlight.current = false
    if (msg) return msg
    // D6：本地先行 merge —— 按鈕 aria-pressed 立即反應，不等 Realtime round-trip（votes.ts）
    setVotes(vs => applyVoteMirror(vs, myUserId, roomId, restaurantId, kind, op))
    return null
  }

  const hasMyVoteForRestaurant = (rid: string, kind: VoteRow['kind']) =>
    hasMyVote(votes, myUserId, rid, kind)
  const ups = upCounts(votes)
  const vetoesRemaining = VETO_QUOTA - myVetoCount(votes, myUserId)

  return { room, members, candidates, draw, myUserId, connected, notFound, loadError,
    refetch, toggleVote, hasMyVote: hasMyVoteForRestaurant, ups, vetoesRemaining }
}

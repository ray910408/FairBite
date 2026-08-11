import { useCallback, useEffect, useRef, useState } from 'react'
import { voteRoom } from '../lib/api'
import { supabase } from '../lib/supabase'
import type { CandidateRow, DrawRow, MemberRow, Room, VoteRow } from '../lib/types'
import { VETO_QUOTA, applyVoteMirror, myVetoCount, myVoteKind, upCounts } from '../lib/votes'

export function useRoom(roomId: string) {
  const [room, setRoom] = useState<Room | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [candidates, setCandidates] = useState<CandidateRow[]>([])
  const [draw, setDraw] = useState<DrawRow | null>(null)
  const [votes, setVotes] = useState<VoteRow[]>([])
  const [myUserId, setMyUserId] = useState('')
  const [connected, setConnected] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const refetch = useCallback(async () => {
    const [r, m, c, d, v] = await Promise.all([
      supabase.from('rooms').select('*').eq('id', roomId).single(),
      supabase.from('room_members').select('*, profiles(display_name)').eq('room_id', roomId),
      supabase.from('room_candidates')
        .select('*, restaurants(name, lat, lng, place_id, source)').eq('room_id', roomId)
        .order('restaurant_id'),
      supabase.from('draws').select('*').eq('room_id', roomId).maybeSingle(),
      supabase.from('votes').select('*').eq('room_id', roomId),
    ])
    // 讀不到房間（不存在、或 RLS 擋掉非成員）要讓 UI 停止無限「載入中」
    setNotFound(!r.data)
    if (r.data) setRoom(r.data as Room)
    setMembers((m.data ?? []) as MemberRow[])
    setCandidates((c.data ?? []) as CandidateRow[])
    setDraw((d.data ?? null) as DrawRow | null)
    setVotes((v.data ?? []) as VoteRow[])
  }, [roomId])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMyUserId(data.user?.id ?? ''))
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
    // 斷線不能靜默：非 SUBSCRIBED 顯示橫幅，恢復時整包重拉補上漏掉的事件
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

  const voteInFlight = useRef(false)
  // 投票唯一入口：算 op、打 API、成功才做本地鏡射；失敗回伺服器訊息字串給呼叫端顯示
  async function toggleVote(restaurantId: string, kind: 'up' | 'veto'): Promise<string | null> {
    if (voteInFlight.current) return null // D6：連點鎖 —— 慢網路下不重送、不閃假錯誤
    voteInFlight.current = true
    const op = myVoteKind(votes, myUserId, restaurantId) === kind ? 'retract' : 'cast'
    const msg = await voteRoom(roomId, restaurantId, kind, op)
      .catch(() => '投票失敗：無法連線到伺服器')
    voteInFlight.current = false
    if (msg) return msg
    // D6：本地先行 merge —— 按鈕 aria-pressed 立即反應，不等 Realtime round-trip（votes.ts）
    setVotes(vs => applyVoteMirror(vs, myUserId, roomId, restaurantId, kind, op))
    return null
  }

  const myVote = (rid: string) => myVoteKind(votes, myUserId, rid)
  const ups = upCounts(votes)
  const vetoesRemaining = VETO_QUOTA - myVetoCount(votes, myUserId)

  return { room, members, candidates, draw, myUserId, connected, notFound, refetch,
    toggleVote, myVote, ups, vetoesRemaining }
}

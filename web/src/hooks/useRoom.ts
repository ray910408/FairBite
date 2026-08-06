import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { CandidateRow, DrawRow, MemberRow, Room } from '../lib/types'

export function useRoom(roomId: string) {
  const [room, setRoom] = useState<Room | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [candidates, setCandidates] = useState<CandidateRow[]>([])
  const [draw, setDraw] = useState<DrawRow | null>(null)
  const [myUserId, setMyUserId] = useState('')
  const [connected, setConnected] = useState(true)
  const [notFound, setNotFound] = useState(false)

  const refetch = useCallback(async () => {
    const [r, m, c, d] = await Promise.all([
      supabase.from('rooms').select('*').eq('id', roomId).single(),
      supabase.from('room_members').select('*, profiles(display_name)').eq('room_id', roomId),
      supabase.from('room_candidates')
        .select('*, restaurants(name, lat, lng, place_id)').eq('room_id', roomId),
      supabase.from('draws').select('*').eq('room_id', roomId).maybeSingle(),
    ])
    // 讀不到房間（不存在、或 RLS 擋掉非成員）要讓 UI 停止無限「載入中」
    setNotFound(!r.data)
    if (r.data) setRoom(r.data as Room)
    setMembers((m.data ?? []) as MemberRow[])
    setCandidates((c.data ?? []) as CandidateRow[])
    setDraw((d.data ?? null) as DrawRow | null)
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
    ]
    // roomId/refetch 變動會重跑本 effect：舊 channel 的 CLOSED 會晚於新 channel 的
    // SUBSCRIBED 抵達，沒有 live 旗標就會把已連線的狀態蓋回「斷線」
    let live = true
    let ch = supabase.channel(`room-${roomId}`)
    for (const t of tables) {
      ch = ch.on('postgres_changes',
        { event: '*', schema: 'public', table: t.table, filter: t.filter }, refetch)
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
    return () => { live = false; supabase.removeChannel(ch) }
  }, [roomId, refetch])

  return { room, members, candidates, draw, myUserId, connected, notFound, refetch }
}

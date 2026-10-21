import { useCallback, useEffect, useRef, useState } from 'react'
import { pickShortlist, voteRoom } from '../lib/api'
import { classifyRoomLoad } from '../lib/roomLoad'
import { applyPickMirror, hasMyPick } from '../lib/shortlist'
import { supabase } from '../lib/supabase'
import type {
  CandidateRow, DrawRow, LocationVoteRow, MemberRow, Room, ShortlistPickRow, ShortlistVoteRow, VoteRow,
} from '../lib/types'
import { getUid } from '../lib/uid'
import { VETO_QUOTA, applyVoteMirror, hasMyVote, myVetoCount, upCounts } from '../lib/votes'

export function useRoom(roomId: string) {
  const [room, setRoom] = useState<Room | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [candidates, setCandidates] = useState<CandidateRow[]>([])
  const [draw, setDraw] = useState<DrawRow | null>(null)
  const [votes, setVotes] = useState<VoteRow[]>([])
  const [locationVotes, setLocationVotes] = useState<LocationVoteRow[]>([])
  const [shortlistVotes, setShortlistVotes] = useState<ShortlistVoteRow[]>([])
  const [shortlistPicks, setShortlistPicks] = useState<ShortlistPickRow[]>([])
  const [myUserId, setMyUserId] = useState('')
  const [connected, setConnected] = useState(true)
  const [notFound, setNotFound] = useState(false)
  const [loadError, setLoadError] = useState(false)
  const refetchGen = useRef(0)
  // 最近一輪以當前輪次身分完成的輪次與結果（寫完 state 是 resolve，查詢拋錯是 reject）
  const lastDone = useRef({ gen: 0, outcome: Promise.resolve() })
  // 被取代、等之後某一輪以當前輪次身分完成的輪次
  const refetchWaiters = useRef<Array<(outcome: Promise<void>) => void>>([])

  // 回傳這輪有沒有把結果寫進 state
  const loadRoom = useCallback(async (gen: number): Promise<boolean> => {
    const [r, m, c, d, v, lv, sv, sp] = await Promise.all([
      // 欄位得寫明：select('*') 會展開成全欄位，撞上 0015 的欄級 grant（center_* 只給
      // service role）會整包 permission denied
      supabase.from('rooms')
        .select('id, code, host_id, status, exploration, meal_time, cuisine_filter, draw_version, search_version').eq('id', roomId).single(),
      supabase.from('room_members').select('*, profiles(display_name)').eq('room_id', roomId),
      supabase.from('room_candidates')
        .select('*, restaurants(name, lat, lng, place_id, source, rating, price_level, cuisine_tags)').eq('room_id', roomId)
        .order('restaurant_id'),
      supabase.from('draws').select('*').eq('room_id', roomId)
        .order('version', { ascending: false }).limit(1).maybeSingle(),
      supabase.from('votes').select('*').eq('room_id', roomId),
      supabase.from('location_change_votes').select('*').eq('room_id', roomId),
      supabase.from('shortlist_votes').select('*').eq('room_id', roomId),
      supabase.from('shortlist_picks').select('*').eq('room_id', roomId),
    ])
    if (gen !== refetchGen.current) return false // 有更新一輪在跑，這輪結果作廢
    // 讀不到房間要讓 UI 停止無限「載入中」；DB/網路錯誤與查無列分開呈現（QA ISSUE-002）
    // 任一查詢失敗都算 loadError；失敗的資料集不覆寫既有 state。
    const state = classifyRoomLoad(r.data, r.error)
    const siblingError = [m, c, d, v, lv, sv, sp].some(x => x.error)
    setNotFound(state === 'not-found')
    setLoadError(state === 'error' || siblingError)
    // 查無列是權威結果（房間已刪或已非成員）：清掉舊快照，頁面才會顯示「找不到房間」而不是
    // 停在舊房、按鈕按了沒反應；暫時性錯誤仍保留舊值（TODOS「useRoom room 過期快照」）
    if (r.data) setRoom(r.data)
    else if (state === 'not-found') setRoom(null)
    if (!m.error) setMembers(m.data ?? [])
    if (!c.error) setCandidates(c.data ?? [])
    if (!d.error) setDraw(d.data ?? null)
    if (!v.error) setVotes(v.data ?? [])
    if (!lv.error) setLocationVotes(lv.data ?? [])
    if (!sv.error) setShortlistVotes(sv.data ?? [])
    if (!sp.error) setShortlistPicks(sp.data ?? [])
    return true
  }, [roomId])

  const refetch = useCallback(async (): Promise<void> => {
    const gen = ++refetchGen.current
    let outcome = Promise.resolve()
    try {
      if (!await loadRoom(gen)) {
        // 被取代：結果作廢，但要等新資料寫進 state 才 resolve（動作成功後 await refetch() 才解鎖按鈕，
        // 提早 resolve 會在新資料前解鎖，按下去伺服器回「房間狀態已變更」）。不綁死取代它的那一輪：
        // 那輪的 fetch 卡住時（supabase-js 沒有預設 timeout），之後別輪寫入也要解得開。
        // 換 roomId 時排隊的輪次等到新房那輪寫入才 resolve，等的人只在乎別在新資料前解鎖；unmount 後
        // 等最新那輪，它卡住的話排隊的 resolve 只掛在這個 ref 上、跟著元件一起被回收，沒有 timer 要清
        if (lastDone.current.gen === refetchGen.current) return lastDone.current.outcome // 最新一輪已完成
        return new Promise<void>(resolve => { refetchWaiters.current.push(resolve) })
      }
    } catch (error) {
      if (gen !== refetchGen.current) throw error // 被取代的輪次失敗只影響自己
      // 當前輪次失敗：排隊的輪次一起 reject。它們的結果早已作廢、state 停在更舊的資料，
      // 回報成功會在舊資料上解鎖按鈕；reject 讓 runAction 照實顯示「重新載入失敗」
      // 不必另掛 catch：下面的 return outcome（與排隊輪次的 settle）在這輪 microtask 清空前就接上 handler，
      // Node／瀏覽器判定 unhandled rejection 時它已經有人接
      outcome = Promise.reject(error)
    }
    if (gen > lastDone.current.gen) lastDone.current = { gen, outcome } // 不倒退；等待者照樣 settle
    for (const settle of refetchWaiters.current.splice(0)) settle(outcome)
    return outcome
  }, [loadRoom])

  useEffect(() => {
    getUid().then(uid => setMyUserId(uid ?? ''))
    // 背景重抓不往外丟 reject：網路／DB 錯誤 postgrest-js 會轉成 { error }、由 loadError 呈現，
    // reject 只剩程式錯誤（本來也只是 console 的 unhandled rejection）；await refetch() 的 runAction 照樣收得到
    const refetchQuietly = () => { void refetch().catch(() => undefined) }
    refetchQuietly()
    // ponytail: 任何相關表變更就整包重抓，P1 資料量小；量大再改增量更新
    // 不訂 room_candidates：每次重算整組重寫，一票就推 N 個 INSERT 給每位成員（Realtime 按人次計量），
    // 我們卻只拿事件當「該重抓」的訊號。改寫候選的交易一定也寫到 rooms：ReplaceCandidates 先刪舊列，
    // 刪除由 signal_room_delete 遞增 rooms.delete_version；房裡還沒有候選的那次是搜尋凍結，會轉換房間狀態。
    // 只改旗標的兩處 UPDATE（pending.go 重轉、shortlist.go 初選定案）都在同一交易裡接著重算或轉換狀態
    const tables = [
      { table: 'rooms', filter: `id=eq.${roomId}` },
      { table: 'room_members', filter: `room_id=eq.${roomId}` },
      { table: 'draws', filter: `room_id=eq.${roomId}` },
      { table: 'votes', filter: `room_id=eq.${roomId}` },
      { table: 'location_change_votes', filter: `room_id=eq.${roomId}` },
      { table: 'shortlist_votes', filter: `room_id=eq.${roomId}` },
      { table: 'shortlist_picks', filter: `room_id=eq.${roomId}` },
    ]
    // roomId/refetch 變動會重跑本 effect：舊 channel 的 CLOSED 會晚於新 channel 的
    // SUBSCRIBED 抵達，沒有 live 旗標就會把已連線的狀態蓋回「斷線」
    let live = true
    // 每筆交易立刻重抓一次：Realtime 只送已 commit 的交易，第一個事件到時整筆都讀得到。一票會推
    // 好幾個事件（votes、rooms…），去抖要等最後一個到齊再多等，手機上拖成一秒多。
    // 同交易的事件共用 commit_timestamp（毫秒精度），後續的略過。同一毫秒 commit 的別筆交易也被略過：
    // 重抓的快照晚於觸發它的 commit 數十毫秒（輪詢＋推播＋網路），通常已含它；殘餘風險是它的 WAL
    // flush 恰好卡住、晚於快照才可見，畫面會停在舊資料到下一筆變更（payload 沒有 xid，無法分辨）
    let coveredCommit: string | undefined
    const onChange = ({ commit_timestamp: commit }: { commit_timestamp?: string }) => {
      // 卸載後 removeChannel 還在非同步離開，舊房事件照樣派發：別拿舊 roomId 重抓蓋掉新房那輪
      if (!live || (commit && commit === coveredCommit)) return
      coveredCommit = commit
      refetchQuietly()
    }
    let ch = supabase.channel(`room-${roomId}`)
    for (const t of tables) {
      ch = ch.on('postgres_changes',
        { event: '*', schema: 'public', table: t.table, filter: t.filter }, onChange)
    }
    // 斷線不能靜默：非 SUBSCRIBED 顯示橫幅，恢復時整包重拉補上漏掉的事件。
    // 首次 SUBSCRIBED 的 refetch 與 mount refetch 重疊是刻意的：補訂閱生效前的
    // 事件空窗（QA ISSUE-006 判定不修，代價是每次進房多一輪查詢）。
    ch.subscribe(status => {
      if (!live) return
      if (status === 'SUBSCRIBED') {
        setConnected(true)
        refetchQuietly()
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') {
        setConnected(false)
      }
    })
    return () => {
      live = false
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

  const pickInFlight = useRef(false)
  // 圈選唯一入口：同 toggleVote 的連點鎖＋成功才本地鏡射；額度上限由伺服器把關（每人最多 5 家）
  async function togglePick(restaurantId: string): Promise<string | null> {
    if (pickInFlight.current) return null
    pickInFlight.current = true
    const op = hasMyPick(shortlistPicks, myUserId, restaurantId) ? 'retract' : 'cast'
    const msg = await pickShortlist(roomId, restaurantId, op, room!.search_version)
      .catch(() => '圈選失敗：無法連線到伺服器')
    pickInFlight.current = false
    if (msg) return msg
    setShortlistPicks(ps => applyPickMirror(ps, myUserId, roomId, restaurantId, op))
    return null
  }

  const hasMyVoteForRestaurant = (rid: string, kind: VoteRow['kind']) =>
    hasMyVote(votes, myUserId, rid, kind)
  const ups = upCounts(votes)
  const vetoesRemaining = VETO_QUOTA - myVetoCount(votes, myUserId)

  return { room, members, candidates, draw, locationVotes, shortlistVotes, shortlistPicks, myUserId, connected,
    notFound, loadError, refetch, toggleVote, togglePick, hasMyVote: hasMyVoteForRestaurant, ups, vetoesRemaining }
}

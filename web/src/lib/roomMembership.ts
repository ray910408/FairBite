import { pendingLeave } from './api'
import { supabase } from './supabase'
import type { Room } from './types'
import { getUid } from './uid'

// 「回首頁＝離席」（ADR-0007）的房籍查詢，HistoryPage 的兩個回首頁入口與
// HomePage 的 mount 攔截共用一份——文案的準確度靠它，複製第二份必走鐘。
// isHost = null：拿不到 uid，不確定是不是房主（leaveNotice 會退回條件句，不猜）
// stale = 殘留房籍（isStaleRoom），HomePage mount 全是殘留房時直接退、不問
export type LeaveRoom = {
  id: string; code: string; status: Room['status']; memberCount: number; isHost: boolean | null; stale: boolean
}
// 查詢失敗時寧可講保守的空話，也不拿過期資料講可能已不成立的後果
export type LeaveTarget = { kind: 'rooms'; rooms: LeaveRoom[] } | { kind: 'unknown' }

// 一次查回「我所屬房間」的全部成員列（members_select RLS = is_room_member(room_id)），
// 依 room_id 分組各自算人數——leave 是全退，每個房都要算。null = 查詢失敗（不可判定），
// 空陣列 = 真的沒房可退（room_members 就是權威）。
// host_id 一起帶回來比對 uid：房主退出會移交（leave.go），文案必須講。
// 5 秒逾時（這條只打 Supabase，不受 Render 冷啟動影響）：三個呼叫端都把
// 自己的閘門押在這個 promise 上——HomePage 的 leavePending（建房/加入/登出全禁用）、
// 兩個房內頁的 aria-busy 與 dialog。連線懸掛（不是失敗，是永不 settle）時沒有逾時就
// 沒有任何出口，使用者被鎖死在頁面上。逾時併入既有的「查詢失敗」路徑（回 null →
// kind:'unknown' 保守 dialog），一樣不猜後果，但至少一定給得出兩顆按鈕。
const QUERY_TIMEOUT_MS = 5000

// ADR-0007 2026-10-01 修訂：用餐時間（未設定＝建房時間）過了 12 小時，這頓早就吃完或不吃了，
// 滑掉 App 或退房請求失敗留下的房籍不該隔幾天還問「回到房間」。時間解析失敗回 false（照舊問）。
const STALE_AFTER_MS = 12 * 60 * 60 * 1000

export function isStaleRoom(createdAt: string, mealTime: string | null, now = Date.now()) {
  return now - Date.parse(mealTime ?? createdAt) > STALE_AFTER_MS
}

export async function fetchLeaveRooms(): Promise<LeaveRoom[] | null> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    // 首頁的退房還在飛（Render 冷啟動可達 50 秒）時先等它落地：查得太早，末位退房
    // 該刪的房還在，足跡頁回首頁就會問要不要離開它（2026-10-10 回報）。失敗也照查——
    // 房籍真的還在就該問。等待上限是 leaveRooms 自己的 60 秒逾時，不計入 QUERY_TIMEOUT_MS。
    const leave = pendingLeave()
    if (leave) await leave.catch(() => {})
    const settled = await Promise.race([
      Promise.all([
        supabase.from('room_members').select('room_id, rooms(code, status, host_id, created_at, meal_time)'),
        getUid().catch(() => null), // uid 掛掉只讓房主敘述退回條件句，不該連整份後果都放棄
      ]),
      new Promise<null>(resolve => { timer = setTimeout(() => resolve(null), QUERY_TIMEOUT_MS) }),
    ])
    if (!settled) return null // 逾時
    const [{ data, error }, uid] = settled
    if (error) return null
    // rooms 是 to-one 嵌入（room_members.room_id FK），實際回物件；supabase-js 推不出
    // 基數而給成陣列，比照 HistoryPage 的 dining_history 嵌入走 unknown 轉型
    const rows = (data ?? []) as unknown as
      { room_id: string; rooms: {
        code: string; status: Room['status']; host_id: string; created_at: string; meal_time: string | null
      } | null }[]
    const byRoom = new Map<string, LeaveRoom>()
    for (const r of rows) {
      if (!r.rooms) continue
      const hit = byRoom.get(r.room_id)
      if (hit) hit.memberCount++
      else byRoom.set(r.room_id, {
        id: r.room_id, code: r.rooms.code, status: r.rooms.status, memberCount: 1,
        isHost: uid ? r.rooms.host_id === uid : null,
        stale: isStaleRoom(r.rooms.created_at, r.rooms.meal_time),
      })
    }
    return [...byRoom.values()]
  } catch {
    return null
  } finally {
    clearTimeout(timer) // 查詢先回來就別留著懸掛的計時器
  }
}

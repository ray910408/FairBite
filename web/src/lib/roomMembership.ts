import { supabase } from './supabase'
import type { Room } from './types'
import { getUid } from './uid'

// 「回首頁＝離席」（ADR-0007）的房籍查詢，HistoryPage 的兩個回首頁入口與
// HomePage 的 mount 攔截共用一份——文案的準確度靠它，複製第二份必走鐘。
// isHost = null：拿不到 uid，不確定是不是房主（leaveNotice 會退回條件句，不猜）
export type LeaveRoom = {
  id: string; code: string; status: Room['status']; memberCount: number; isHost: boolean | null
}
// 查詢失敗時寧可講保守的空話，也不拿過期資料講可能已不成立的後果
export type LeaveTarget = { kind: 'rooms'; rooms: LeaveRoom[] } | { kind: 'unknown' }

// 一次查回「我所屬房間」的全部成員列（members_select RLS = is_room_member(room_id)），
// 依 room_id 分組各自算人數——leave 是全退，每個房都要算。null = 查詢失敗（不可判定），
// 空陣列 = 真的沒房可退（room_members 就是權威）。
// host_id 一起帶回來比對 uid：房主退出會移交（leave.go），文案必須講。
export async function fetchLeaveRooms(): Promise<LeaveRoom[] | null> {
  try {
    const [{ data, error }, uid] = await Promise.all([
      supabase.from('room_members').select('room_id, rooms(code, status, host_id)'),
      getUid().catch(() => null), // uid 掛掉只讓房主敘述退回條件句，不該連整份後果都放棄
    ])
    if (error) return null
    // rooms 是 to-one 嵌入（room_members.room_id FK），實際回物件；supabase-js 推不出
    // 基數而給成陣列，比照 HistoryPage 的 dining_history 嵌入走 unknown 轉型
    const rows = (data ?? []) as unknown as
      { room_id: string; rooms: { code: string; status: Room['status']; host_id: string } | null }[]
    const byRoom = new Map<string, LeaveRoom>()
    for (const r of rows) {
      if (!r.rooms) continue
      const hit = byRoom.get(r.room_id)
      if (hit) hit.memberCount++
      else byRoom.set(r.room_id, {
        id: r.room_id, code: r.rooms.code, status: r.rooms.status, memberCount: 1,
        isHost: uid ? r.rooms.host_id === uid : null,
      })
    }
    return [...byRoom.values()]
  } catch {
    return null
  }
}

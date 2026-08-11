import type { CandidateRow } from './types'

// 死路種類判定與伺服器同源（handlers.go hasKind(e.Kinds,"veto")）：
// 結構化 kinds 是 contract，exclusion_reason 只是顯示文案。
// 呼叫端（RoomPage）已先以「無 kept」判定死路，這裡只分辨是否為否決死路。
export function isVetoDeadEnd(candidates: CandidateRow[]): boolean {
  return candidates.some(c => c.exclusion_kinds?.includes('veto'))
}

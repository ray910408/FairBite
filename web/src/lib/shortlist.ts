import type { CandidateRow, ShortlistPickRow } from './types'

// 鏡射 server/shortlist.go 的 ShortlistPickMin／ShortlistPickMax／ShortlistGatePerMember——client 側唯一鏡本
export const SHORTLIST_PICK_MIN = 3
export const SHORTLIST_PICK_MAX = 5
export const SHORTLIST_GATE_PER_MEMBER = 3

// 初選表決開放門檻：可抽（kept）候選嚴格多於成員數 × 3
export function shortlistOpen(keptCount: number, memberCount: number): boolean {
  return keptCount > memberCount * SHORTLIST_GATE_PER_MEMBER
}

export function hasMyPick(picks: ShortlistPickRow[], uid: string, rid: string): boolean {
  return picks.some(p => p.user_id === uid && p.restaurant_id === rid)
}

// 每家店被幾位成員圈選（公開資訊）
export function pickCounts(picks: ShortlistPickRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const p of picks) counts[p.restaurant_id] = (counts[p.restaurant_id] ?? 0) + 1
  return counts
}

// 每位成員的圈選數：只算目前仍是 kept 的候選（同 server keptPicksSQL），
// 被退房重算排除的店不算數
export function keptPickCounts(picks: ShortlistPickRow[], candidates: CandidateRow[]): Record<string, number> {
  const kept = new Set(candidates.filter(c => c.status === 'kept').map(c => c.restaurant_id))
  const counts: Record<string, number> = {}
  for (const p of picks) {
    if (kept.has(p.restaurant_id)) counts[p.user_id] = (counts[p.user_id] ?? 0) + 1
  }
  return counts
}

// 還沒圈滿下限的成員數（含房主）；0 才能開始投票
export function membersBelowMin(members: { user_id: string }[], counts: Record<string, number>): number {
  return members.filter(m => (counts[m.user_id] ?? 0) < SHORTLIST_PICK_MIN).length
}

// 本地先行 merge（比照 votes.ts applyVoteMirror）：權威資料稍後由 Realtime refetch 帶回
export function applyPickMirror(picks: ShortlistPickRow[], uid: string, roomId: string, rid: string,
  op: 'cast' | 'retract'): ShortlistPickRow[] {
  const others = picks.filter(p => !(p.user_id === uid && p.restaurant_id === rid))
  return op === 'retract' ? others : [...others, { room_id: roomId, user_id: uid, restaurant_id: rid }]
}

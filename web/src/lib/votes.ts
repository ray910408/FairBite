import type { VoteRow } from './types'

export const VETO_QUOTA = 2 // 鏡射 server/weights.go VetoQuota——client 側唯一鏡本

export function hasMyVote(votes: VoteRow[], uid: string, rid: string, kind: VoteRow['kind']): boolean {
  return votes.some(v => v.user_id === uid && v.restaurant_id === rid && v.kind === kind)
}

export function upCounts(votes: VoteRow[]): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const v of votes) {
    if (v.kind === 'up') counts[v.restaurant_id] = (counts[v.restaurant_id] ?? 0) + 1
  }
  return counts
}

export function myVetoCount(votes: VoteRow[], uid: string): number {
  return votes.filter(v => v.user_id === uid && v.kind === 'veto').length
}

// D6 本地先行 merge：只取代自己同店同 kind；retract 移除該票。
// 權威資料稍後由 Realtime refetch 帶回
export function applyVoteMirror(votes: VoteRow[], uid: string, roomId: string, rid: string,
  kind: 'up' | 'veto', op: 'cast' | 'retract'): VoteRow[] {
  return op === 'retract'
    ? votes.filter(v => !(v.user_id === uid && v.restaurant_id === rid && v.kind === kind))
    : [...votes.filter(v => !(v.user_id === uid && v.restaurant_id === rid && v.kind === kind)),
        { room_id: roomId, user_id: uid, restaurant_id: rid, kind }]
}

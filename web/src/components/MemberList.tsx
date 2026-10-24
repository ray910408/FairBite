import { SHORTLIST_PICK_MIN } from '../lib/shortlist'
import type { MemberRow, Room } from '../lib/types'
import { Check } from './icons'

// 菜單式狀態列：成員名……狀態。準備、初選圈滿、已投票共用 ok 色
const MEMBER_STATUS = 'inline-flex items-center gap-1 whitespace-nowrap text-sm'

function badge(done: boolean, label: string) {
  return (
    <span className={`${MEMBER_STATUS} ${done ? 'text-ok' : 'text-fg-muted'}`}>
      {done && <Check className="h-3.5 w-3.5 shrink-0" />}
      {label}
    </span>
  )
}

// 每個階段只講那一步在等什麼：準備只在 lobby 有意義（房主免準備），搜尋之後不再顯示；
// 初選看每人（含房主）圈了幾家；投票看每人（含房主）投了幾票——投票沒有「投完」的動作，房主靠它判斷何時轉
function memberStatus(room: Room, m: MemberRow, picksByMember: Record<string, number>,
  votesByMember: Record<string, number>) {
  if (room.status === 'shortlisting') {
    const picks = picksByMember[m.user_id] ?? 0
    return badge(picks >= SHORTLIST_PICK_MIN,
      picks >= SHORTLIST_PICK_MIN ? `已圈 ${picks} 家` : `圈選中 ${picks}/${SHORTLIST_PICK_MIN}`)
  }
  if (room.status === 'voting') {
    const votes = votesByMember[m.user_id] ?? 0
    return badge(votes > 0, votes > 0 ? `已投 ${votes} 票` : '還沒投票')
  }
  if (room.status === 'lobby' && m.user_id !== room.host_id) return badge(m.ready, m.ready ? '已準備' : '設定中')
  return null
}

export function MemberList({ room, members, picksByMember, votesByMember }: {
  room: Room
  members: MemberRow[]
  picksByMember: Record<string, number>
  votesByMember: Record<string, number>
}) {
  return (
    <section className="animate-rise">
      <h2 className="mb-1.5 text-[0.9375rem] font-bold">成員（{members.length}）</h2>
      <ul>
        {members.map(m => (
          <li key={m.user_id} className="flex items-baseline gap-1.5 py-1.5">
            <span className="min-w-0 truncate font-serif font-medium">
              {m.profiles?.display_name ?? '成員'}
            </span>
            <span aria-hidden="true" className="leader" />
            {m.user_id === room.host_id && (
              // 括號只給報讀器：印章裡只蓋「發起人」三字
              <span className="seal px-1 py-0 text-xs">
                <span className="sr-only">（</span>發起人<span className="sr-only">）</span>
              </span>
            )}
            {memberStatus(room, m, picksByMember, votesByMember)}
          </li>
        ))}
      </ul>
    </section>
  )
}

import { SHORTLIST_PICK_MIN } from '../lib/shortlist'
import type { MemberRow, Room } from '../lib/types'
import { Check } from './icons'

// 菜單式狀態列：成員名……狀態。ready 與初選圈滿共用 ok 色
const MEMBER_STATUS = 'inline-flex items-center gap-1 whitespace-nowrap text-sm'

// 初選中每位成員（含房主）的圈選進度；圈滿下限用 ok 樣式，比照「已準備」
function pickBadge(count: number) {
  const done = count >= SHORTLIST_PICK_MIN
  return (
    <span className={`${MEMBER_STATUS} ${done ? 'text-ok' : 'text-fg-muted'}`}>
      {done && <Check className="h-3.5 w-3.5 shrink-0" />}
      {done ? `已圈 ${count} 家` : `圈選中 ${count}/${SHORTLIST_PICK_MIN}`}
    </span>
  )
}

// 以函式呼叫（MemberList({...})）而非 <MemberList />：比照 LeaveConfirm，本元件沒有自己的狀態，
// RoomPage.test.ts 把頁面當純函式呼叫，要在回傳的元素樹裡讀到各成員的狀態文字。
// 所以這裡禁止用 hook：hook 會記在 RoomPage 上，房間載入前頁面提早 return、不會呼叫本元件，hook 數量
// 一變整頁崩潰，oxlint 的 rules-of-hooks 抓不到。改回 <MemberList /> 要等 RoomPage.test.ts 改成行為導向（TODOS #14）
export function MemberList({ room, members, picksByMember }: {
  room: Room
  members: MemberRow[]
  picksByMember: Record<string, number>
}) {
  return (
    <section className="animate-rise">
      <h2 className="mb-1.5 text-[15px] font-bold">成員（{members.length}）</h2>
      <ul>
        {members.map(m => (
          <li key={m.user_id} className="flex items-baseline gap-1.5 py-1.5">
            <span className="min-w-0 truncate font-serif font-medium">
              {m.profiles?.display_name ?? '成員'}
            </span>
            <span aria-hidden="true" className="leader" />
            {m.user_id === room.host_id && (
              // 括號只給報讀器：印章裡只蓋「房主」兩字
              <span className="seal px-1 py-0 text-xs">
                <span className="sr-only">（</span>房主<span className="sr-only">）</span>
              </span>
            )}
            {room.status === 'shortlisting' ? (
              pickBadge(picksByMember[m.user_id] ?? 0)
            ) : m.user_id !== room.host_id && (
              <span className={`${MEMBER_STATUS} ${m.ready ? 'text-ok' : 'text-fg-muted'}`}>
                {m.ready && <Check className="h-3.5 w-3.5 shrink-0" />}
                {m.ready ? '已準備' : '設定中'}
              </span>
            )}
          </li>
        ))}
      </ul>
    </section>
  )
}

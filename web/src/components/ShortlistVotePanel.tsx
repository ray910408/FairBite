import { SHORTLIST_PICK_MAX, SHORTLIST_PICK_MIN } from '../lib/shortlist'

type Props = {
  wantShortlist: boolean
  yesCount: number
  memberCount: number
  busy: boolean
  onVote: (want: boolean) => void
}

// 初選表決（CONTEXT.md）：RoomPage 只在候選出爐且可抽候選多於成員數三倍時掛上。
// 嚴格過半由伺服器在同一交易內把房間轉進初選，這裡只負責表達／收回意願
export default function ShortlistVotePanel({ wantShortlist, yesCount, memberCount, busy, onVote }: Props) {
  const majority = Math.floor(memberCount / 2) + 1
  return (
    <section className="card space-y-2" aria-labelledby="shortlist-vote-title">
      <h2 id="shortlist-vote-title" className="text-base font-semibold">候選太多？先初選再投票</h2>
      <p className="text-sm text-fg-muted">每人圈 {SHORTLIST_PICK_MIN} 到 {SHORTLIST_PICK_MAX} 家，沒人圈的店不進轉盤</p>
      <label className="flex min-h-11 items-center gap-3 text-sm">
        <input type="checkbox" className="h-5 w-5" checked={wantShortlist}
          aria-checked={wantShortlist} disabled={busy}
          onChange={e => onVote(e.target.checked)} />
        <span>我想先初選</span>
      </label>
      <p className="text-xs text-fg-muted">目前 {yesCount}/{memberCount} 票，需 {majority} 票才會進入初選</p>
    </section>
  )
}

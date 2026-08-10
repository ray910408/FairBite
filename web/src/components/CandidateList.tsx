import type { CandidateRow, VoteRow } from '../lib/types'
import { isGoogleSourced } from '../lib/placesSource'
import { chipLabel, formatPercents, sortExcluded, sortKept } from '../lib/probability'
import { Chevron } from './icons'

type VotingProps = {
  votes: VoteRow[]
  myUserId: string
  onToggle: (restaurantId: string, kind: 'up' | 'veto') => void
}

const VETO_QUOTA = 2 // UI 顯示常數，與 Go VetoQuota 一致

export default function CandidateList({ rows, voting }: { rows: CandidateRow[]; voting?: VotingProps }) {
  const kept = sortKept(rows)
  const percents = formatPercents(kept.map(c => c.probability ?? 0))
  const excluded = sortExcluded(rows)
  const max = Math.max(...kept.map(c => c.probability ?? 0), 0.0001)
  const showGoogleAttribution = rows.some(c => isGoogleSourced(c.restaurants.place_id))

  const ups = (rid: string) => voting!.votes.filter(v => v.restaurant_id === rid && v.kind === 'up').length
  const mine = (rid: string, kind: VoteRow['kind']) =>
    voting!.votes.some(v => v.restaurant_id === rid && v.user_id === voting!.myUserId && v.kind === kind)
  const myVetoes = voting ? voting.votes.filter(v => v.user_id === voting.myUserId && v.kind === 'veto').length : 0

  return (
    <div className="space-y-3">
      <div className="flex items-baseline justify-between">
        <h2 className="text-base font-semibold">候選餐廳（{kept.length}）</h2>
        {voting && (
          <span className="text-xs text-fg-muted">否決額度 {VETO_QUOTA - myVetoes}/{VETO_QUOTA}（可收回）</span>
        )}
      </div>
      {kept.map((c, ci) => (
        <div key={c.restaurant_id} className="card animate-rise space-y-2 p-3">
          <div className="flex items-baseline gap-2">
            <span aria-hidden="true" className="font-mono text-xs text-fg-muted">{ci + 1}</span>
            <span className="flex-1 font-semibold">{c.restaurants.name}</span>
            <span className="font-mono text-sm font-semibold text-brand">{percents[ci]}</span>
          </div>
          <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-brand-soft">
            <div className="h-full rounded-full bg-brand"
              style={{ width: `${((c.probability ?? 0) / max) * 100}%` }} />
          </div>
          <div className="flex flex-wrap gap-1">
            {c.weight_breakdown.map((e, i) => (
              <span key={i}
                className={`rounded-full px-2 py-0.5 text-xs ${
                  e.mult > 1 ? 'bg-ok-soft text-ok'
                    : e.mult < 1 ? 'bg-danger-soft text-danger'
                    : 'bg-canvas text-fg-muted'
                }`}>
                {chipLabel(e)}
              </span>
            ))}
          </div>
          {voting && (
            <div className="flex gap-2 border-t border-border pt-2">
              <button type="button" aria-pressed={mine(c.restaurant_id, 'up')}
                className={`btn flex-1 text-sm ${mine(c.restaurant_id, 'up') ? 'btn-primary' : 'btn-quiet'}`}
                onClick={() => voting.onToggle(c.restaurant_id, 'up')}>
                👍 贊成{ups(c.restaurant_id) > 0 ? `（${ups(c.restaurant_id)}）` : ''}
              </button>
              <button type="button" aria-pressed={mine(c.restaurant_id, 'veto')}
                disabled={!mine(c.restaurant_id, 'veto') && myVetoes >= VETO_QUOTA}
                className="btn btn-quiet flex-1 text-sm text-danger disabled:opacity-40"
                onClick={() => voting.onToggle(c.restaurant_id, 'veto')}>
                否決
              </button>
            </div>
          )}
        </div>
      ))}
      {excluded.length > 0 && (
        <details className="card p-3" open={voting != null}>
          <summary className="flex list-none items-center gap-2 text-sm text-fg-muted [&::-webkit-details-marker]:hidden">
            <Chevron className="disclosure-chevron h-4 w-4" />
            被排除的 {excluded.length} 家
          </summary>
          <ul className="mt-3 space-y-2 border-t border-border pt-3">
            {excluded.map(c => (
              <li key={c.restaurant_id} className="flex items-center gap-2 text-sm text-fg-muted">
                <span className="flex-1 line-through">{c.restaurants.name}</span>
                <span className="text-xs">{c.exclusion_reason}</span>
                {voting && mine(c.restaurant_id, 'veto') && (
                  <button type="button" className="btn btn-quiet shrink-0 px-2 py-1 text-xs"
                    onClick={() => voting.onToggle(c.restaurant_id, 'veto')}>
                    收回否決
                  </button>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
      {showGoogleAttribution && (
        <p className="text-xs text-fg-muted">餐廳資料 Powered by Google</p>
      )}
    </div>
  )
}

import type { CandidateRow } from '../lib/types'
import { chipLabel, formatPercents, sortExcluded, sortKept } from '../lib/probability'
import { Chevron } from './icons'

export default function CandidateList({ rows }: { rows: CandidateRow[] }) {
  const kept = sortKept(rows)
  const percents = formatPercents(kept.map(c => c.probability ?? 0))
  const excluded = sortExcluded(rows)
  // 條長度相對於最高機率，差距才看得出來；精確數字就在旁邊
  const max = Math.max(...kept.map(c => c.probability ?? 0), 0.0001)

  return (
    <div className="space-y-3">
      <h2 className="text-base font-semibold">候選餐廳（{kept.length}）</h2>
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
        </div>
      ))}
      {excluded.length > 0 && (
        <details className="card p-3">
          <summary className="flex list-none items-center gap-2 text-sm text-fg-muted [&::-webkit-details-marker]:hidden">
            <Chevron className="disclosure-chevron h-4 w-4" />
            被排除的 {excluded.length} 家
          </summary>
          <ul className="mt-3 space-y-2 border-t border-border pt-3">
            {excluded.map(c => (
              <li key={c.restaurant_id} className="flex gap-2 text-sm text-fg-muted">
                <span className="flex-1 line-through">{c.restaurants.name}</span>
                <span className="text-xs">{c.exclusion_reason}</span>
              </li>
            ))}
          </ul>
        </details>
      )}
    </div>
  )
}

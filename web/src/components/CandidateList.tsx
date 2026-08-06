import { useState } from 'react'
import type { CandidateRow } from '../lib/types'
import { chipLabel, formatPercents, sortExcluded, sortKept } from '../lib/probability'

export default function CandidateList({ rows }: { rows: CandidateRow[] }) {
  const [showExcluded, setShowExcluded] = useState(false)
  const kept = sortKept(rows)
  const percents = formatPercents(kept.map(c => c.probability ?? 0))
  const excluded = sortExcluded(rows)

  return (
    <div className="space-y-3">
      {kept.map((c, ci) => (
        <div key={c.restaurant_id} className="rounded border p-3">
          <div className="flex justify-between">
            <span className="font-medium">{c.restaurants.name}</span>
            <span className="font-mono text-orange-600">
              {percents[ci]}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {c.weight_breakdown.map((e, i) => (
              <span key={i}
                className={`rounded-full px-2 py-0.5 text-xs ${e.mult > 1 ? 'bg-green-100 text-green-800' : e.mult < 1 ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}`}>
                {chipLabel(e)}
              </span>
            ))}
          </div>
        </div>
      ))}
      {excluded.length > 0 && (
        <div>
          <button className="text-sm text-gray-500 underline"
            onClick={() => setShowExcluded(!showExcluded)}>
            {showExcluded ? '隱藏' : '顯示'}被排除的 {excluded.length} 家
          </button>
          {showExcluded && (
            <ul className="mt-2 space-y-1">
              {excluded.map(c => (
                <li key={c.restaurant_id} className="text-sm text-gray-500">
                  {c.restaurants.name} — {c.exclusion_reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}

import type { CandidateRow, DrawRow, MemberRow } from '../lib/types'
import { buildMapsUrl } from '../lib/maps'
import { formatPercent } from '../lib/probability'
import { TRANSPORT_LABELS } from '../lib/labels'

export default function ResultCard({ draw, candidates, me }: {
  draw: DrawRow
  candidates: CandidateRow[]
  me: MemberRow | undefined
}) {
  const winner = candidates.find(c => c.restaurant_id === draw.winner_restaurant_id)
  if (!winner) return null
  const r = winner.restaurants
  const prob = draw.probabilities[draw.winner_restaurant_id] ?? 0
  return (
    <div className="space-y-3 rounded border-2 border-orange-500 p-4 text-center">
      <p className="text-sm text-gray-500">今天就吃</p>
      <h2 className="text-2xl font-bold">{r.name}</h2>
      <p className="text-sm text-gray-500">抽中機率 {formatPercent(prob)}</p>
      <a className="block rounded bg-blue-600 p-3 text-white"
        href={buildMapsUrl(r.lat, r.lng, r.place_id, me?.transport ?? 'walking')}
        target="_blank" rel="noreferrer">
        用 Google Maps 導航（{TRANSPORT_LABELS[me?.transport ?? 'walking']}）
      </a>
    </div>
  )
}

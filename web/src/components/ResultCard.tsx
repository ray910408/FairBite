import type { CandidateRow, DrawRow, MemberRow } from '../lib/types'
import { buildMapsUrl } from '../lib/maps'
import { formatPercent } from '../lib/probability'
import { TRANSPORT_LABELS } from '../lib/labels'
import { MapPin } from './icons'

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
    <div className="card animate-rise space-y-4 border-brand bg-linear-to-b from-brand-soft to-surface p-6 text-center">
      <p className="text-sm font-medium tracking-wide text-brand-strong">今天就吃</p>
      <h2 className="text-3xl font-bold tracking-tight">{r.name}</h2>
      <p className="text-sm text-fg-muted">
        抽中機率 <span className="font-mono font-semibold text-fg">{formatPercent(prob)}</span>
      </p>
      <a className="btn btn-accent w-full"
        href={buildMapsUrl(r.lat, r.lng, r.place_id, r.source, me?.transport ?? 'walking')}
        target="_blank" rel="noreferrer">
        <MapPin className="h-5 w-5" />
        用 Google Maps 導航（{TRANSPORT_LABELS[me?.transport ?? 'walking']}）
      </a>
    </div>
  )
}

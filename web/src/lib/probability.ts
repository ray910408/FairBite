import type { CandidateRow, TraceEntry } from './types'

export const FACTOR_LABELS: Record<string, string> = {
  preference: '偏好',
  distance: '距離',
  closing_soon: '打烊',
}

export function formatPercent(p: number): string {
  if (p > 0 && p < 0.01) return '<1%'
  return `${(p * 100).toFixed(1)}%`
}

export function chipLabel(e: TraceEntry): string {
  const name = FACTOR_LABELS[e.factor] ?? e.factor
  return `${name} ×${e.mult.toFixed(2)} · ${e.reason}`
}

export function sortKept(rows: CandidateRow[]): CandidateRow[] {
  return rows
    .filter(r => r.status === 'kept')
    .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))
}

export function sortExcluded(rows: CandidateRow[]): CandidateRow[] {
  return rows.filter(r => r.status === 'excluded')
}

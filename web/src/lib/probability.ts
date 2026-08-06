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

// 清單各自四捨五入會湊出 100.1%：改用最大餘數法分配 1000 個 0.1% 單位，總和必為 100.0%
export function formatPercents(probs: number[]): string[] {
  if (probs.length === 0) return []
  const total = probs.reduce((s, p) => s + p, 0)
  if (total <= 0) return probs.map(() => '0.0%')
  const scaled = probs.map(p => (p / total) * 1000)
  const units = scaled.map(Math.floor)
  const rest = 1000 - units.reduce((s, u) => s + u, 0)
  scaled
    .map((s, i) => ({ i, frac: s - Math.floor(s) }))
    .sort((a, b) => b.frac - a.frac || a.i - b.i) // 餘數相同時取較前的索引，結果才穩定
    .slice(0, rest)
    .forEach(({ i }) => units[i]++)
  return units.map(u => `${(u / 10).toFixed(1)}%`)
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

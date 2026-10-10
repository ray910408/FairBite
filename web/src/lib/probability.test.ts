import { describe, expect, it, test } from 'vitest'
import { chipLabel, decisiveFactors, formatPercent, formatPercents, snapshotCandidates, sortKept } from './probability'
import type { CandidateRow, TraceEntry } from './types'

const cand = (p: number | null, status: 'kept' | 'excluded' = 'kept'): CandidateRow => ({
  room_id: 'r', restaurant_id: String(p), status, probability: p,
  weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
  restaurants: { name: 'x', lat: 0, lng: 0, place_id: 'p', source: 'google' },
})

test('轉盤使用不可變 draw snapshot，不讀重算後的 live odds', () => {
  const live = [cand(0.9), { ...cand(0.1), restaurant_id: 'other' }]
  expect(snapshotCandidates(live, { '0.9': 0.25, other: 0.75 }).map(r => r.probability))
    .toEqual([0.25, 0.75])
})

test('P2 新因素有中文標籤', () => {
  expect(chipLabel({ factor: 'votes', mult: 1.2, reason: '2 張贊成票' }))
    .toBe('投票 ×1.20 · 2 張贊成票')
  expect(chipLabel({ factor: 'recency', mult: 0.65, reason: '2 位成員 14 天內造訪過' }))
    .toBe('最近去過 ×0.65 · 2 位成員 14 天內造訪過')
})

describe('formatPercent', () => {
  it('一般值取一位小數', () => expect(formatPercent(0.3121)).toBe('31.2%'))
  it('小於 1% 顯示 <1%', () => expect(formatPercent(0.004)).toBe('<1%'))
  it('1 顯示 100%', () => expect(formatPercent(1)).toBe('100.0%'))
})

// Regression: ISSUE-005 — 候選機率顯示總和 100.1%
// Found by /qa on 2026-08-06
// Report: .gstack/qa-reports/qa-report-localhost-5173-2026-08-06.md
describe('formatPercents', () => {
  const sum = (out: string[]) => out.reduce((s, x) => s + parseFloat(x), 0)

  it('QA 案例：各自四捨五入會得到 100.1%', () => {
    const probs = [0.2118, 0.2118, 0.0848, 0.0848, 0.0848, 0.083, 0.08, 0.08, 0.079]
    expect(sum(probs.map(formatPercent))).toBeCloseTo(100.1, 10)
    expect(sum(formatPercents(probs))).toBeCloseTo(100, 10)
  })

  it('其他分佈總和也是 100.0%', () => {
    expect(sum(formatPercents([1 / 3, 1 / 3, 1 / 3]))).toBeCloseTo(100, 10)
    expect(sum(formatPercents([0.4444, 0.2222, 0.1667, 0.1667]))).toBeCloseTo(100, 10)
  })

  it('空陣列回傳空陣列', () => expect(formatPercents([])).toEqual([]))
  it('單一項目顯示 100.0%', () => expect(formatPercents([1])).toEqual(['100.0%']))
  it('總和為 0 時全部顯示 0.0%', () =>
    expect(formatPercents([0, 0])).toEqual(['0.0%', '0.0%']))
})

describe('chipLabel', () => {
  it('加權顯示 ×值與理由', () =>
    expect(chipLabel({ factor: 'preference', mult: 1.3, reason: '3/4 位成員偏好命中' }))
      .toBe('偏好 ×1.30 · 3/4 位成員偏好命中'))
  it('未知 factor 用原名', () =>
    expect(chipLabel({ factor: 'mystery', mult: 1, reason: 'r' })).toContain('mystery'))
})

describe('sortKept', () => {
  it('依機率由高到低且只留 kept', () => {
    const rows = [cand(0.1), cand(0.5), cand(null, 'excluded'), cand(0.4)]
    expect(sortKept(rows).map(r => r.probability)).toEqual([0.5, 0.4, 0.1])
  })
})

describe('decisiveFactors', () => {
  const f = (factor: string, mult: number): TraceEntry => ({ factor, mult, reason: factor })
  const row = (...wb: TraceEntry[]): CandidateRow => ({ ...cand(0.5), weight_breakdown: wb })
  it('中性倍率與全場同倍率不顯示，會拉開差距的才顯示', () => {
    const rows = [
      row(f('votes', 1), f('preference', 0.6), f('distance', 1.2)),
      row(f('votes', 1), f('preference', 0.6), f('distance', 1.18)),
    ]
    const show = decisiveFactors(rows)
    expect(rows.map(r => r.weight_breakdown.filter(show).map(e => e.factor)))
      .toEqual([['distance'], ['distance']])
  })
  it('只有部分候選帶同一倍率時照樣顯示', () => {
    const rows = [row(f('votes', 1.2)), row(f('votes', 1.2)), row()]
    expect(rows[0].weight_breakdown.filter(decisiveFactors(rows))).toHaveLength(1)
  })
  it('只剩一家時不套全場規則，非中性倍率照樣顯示', () => {
    const rows = [row(f('preference', 0.6), f('votes', 1))]
    expect(rows[0].weight_breakdown.filter(decisiveFactors(rows)).map(e => e.factor)).toEqual(['preference'])
  })
  it('倍率相同但原因不同（各家打烊時刻）照樣顯示', () => {
    const rows = [
      row({ factor: 'closing_soon', mult: 0.6, reason: '21:15 打烊' }),
      row({ factor: 'closing_soon', mult: 0.6, reason: '21:30 打烊' }),
    ]
    const show = decisiveFactors(rows)
    expect(rows.map(r => r.weight_breakdown.filter(show).length)).toEqual([1, 1])
  })
  it('依原始倍率判斷：印成 ×1.00 但不是 1、或只差在小數後幾位，都會拉開機率，照樣顯示', () => {
    const rows = [
      row(f('distance', 0.996), f('preference', 0.6000000001)),
      row(f('distance', 1.004), f('preference', 0.6)),
    ]
    const show = decisiveFactors(rows)
    expect(rows.map(r => r.weight_breakdown.filter(show).map(e => e.factor)))
      .toEqual([['distance', 'preference'], ['distance', 'preference']])
  })
})

import { describe, expect, it } from 'vitest'
import { chipLabel, formatPercent, sortKept } from './probability'
import type { CandidateRow } from './types'

const cand = (p: number | null, status: 'kept' | 'excluded' = 'kept'): CandidateRow => ({
  room_id: 'r', restaurant_id: String(p), status, probability: p,
  weight_breakdown: [], exclusion_reason: null,
  restaurants: { name: 'x', lat: 0, lng: 0, place_id: 'p' },
})

describe('formatPercent', () => {
  it('一般值取一位小數', () => expect(formatPercent(0.3121)).toBe('31.2%'))
  it('小於 1% 顯示 <1%', () => expect(formatPercent(0.004)).toBe('<1%'))
  it('1 顯示 100%', () => expect(formatPercent(1)).toBe('100.0%'))
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

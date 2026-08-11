import { expect, test } from 'vitest'
import { isVetoDeadEnd } from './deadEnd'
import type { CandidateRow } from './types'

const excluded = (kinds: string[]): CandidateRow => ({
  room_id: 'r', restaurant_id: kinds.join('-') || 'none', status: 'excluded',
  probability: null, weight_breakdown: [], exclusion_reason: null, exclusion_kinds: kinds,
  restaurants: { name: 'x', lat: 0, lng: 0, place_id: 'p', source: 'google' },
})

test('含 veto kind → 否決死路', () =>
  expect(isVetoDeadEnd([excluded(['closed']), excluded(['veto'])])).toBe(true))

test('全非 veto 排除 → 非否決死路', () =>
  expect(isVetoDeadEnd([excluded(['closed']), excluded(['budget', 'dietary'])])).toBe(false))

// 與 RoomPage 現行語意一致：無守衛，空集合單純回 false
test('空集合 → false', () => expect(isVetoDeadEnd([])).toBe(false))

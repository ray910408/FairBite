import { expect, test } from 'vitest'
import {
  SHORTLIST_GATE_PER_MEMBER, SHORTLIST_PICK_MAX, SHORTLIST_PICK_MIN,
  applyPickMirror, hasMyPick, keptPickCounts, membersBelowMin, pickCounts, shortlistOpen,
} from './shortlist'
import type { CandidateRow, ShortlistPickRow } from './types'

const pick = (uid: string, rid: string): ShortlistPickRow => ({ room_id: 'room', user_id: uid, restaurant_id: rid })
const cand = (rid: string, status: CandidateRow['status']): CandidateRow => ({
  room_id: 'room', restaurant_id: rid, status, probability: null, weight_breakdown: [],
  exclusion_reason: null, exclusion_kinds: [],
  restaurants: { name: rid, lat: 0, lng: 0, place_id: rid, source: 'mock' },
})

// 改常數要同步 server/shortlist.go
test('常數鏡本與 server/shortlist.go 一致', () => {
  expect([SHORTLIST_PICK_MIN, SHORTLIST_PICK_MAX, SHORTLIST_GATE_PER_MEMBER]).toEqual([3, 5, 3])
})

test('shortlistOpen 要嚴格多於成員數 × 3', () => {
  expect(shortlistOpen(6, 2)).toBe(false)
  expect(shortlistOpen(7, 2)).toBe(true)
  expect(shortlistOpen(3, 1)).toBe(false)
  expect(shortlistOpen(4, 1)).toBe(true)
})

test('pickCounts 依店聚合所有成員的圈選', () =>
  expect(pickCounts([pick('a', 'r1'), pick('b', 'r1'), pick('a', 'r2')])).toEqual({ r1: 2, r2: 1 }))

test('keptPickCounts 依成員聚合，只算仍是 kept 的候選', () => {
  const candidates = [cand('r1', 'kept'), cand('r2', 'kept'), cand('r3', 'excluded')]
  expect(keptPickCounts([pick('a', 'r1'), pick('a', 'r2'), pick('a', 'r3'), pick('b', 'r3'), pick('b', 'gone')],
    candidates)).toEqual({ a: 2 })
})

test('membersBelowMin 含房主、沒圈過的成員算未圈滿', () => {
  const members = [{ user_id: 'host' }, { user_id: 'a' }, { user_id: 'b' }]
  expect(membersBelowMin(members, { host: 3, a: 5, b: 2 })).toBe(1)
  expect(membersBelowMin(members, { host: 3, a: 3 })).toBe(1)
  expect(membersBelowMin(members, { host: 3, a: 3, b: 3 })).toBe(0)
})

test('hasMyPick 只認自己的圈選', () => {
  expect(hasMyPick([pick('other', 'r1')], 'me', 'r1')).toBe(false)
  expect(hasMyPick([pick('me', 'r1')], 'me', 'r1')).toBe(true)
})

test('applyPickMirror cast 冪等、retract 只移除自己同店', () => {
  const picks = [pick('me', 'r1'), pick('other', 'r1')]
  expect(applyPickMirror(picks, 'me', 'room', 'r1', 'cast')).toEqual([pick('other', 'r1'), pick('me', 'r1')])
  expect(applyPickMirror(picks, 'me', 'room', 'r2', 'cast')).toEqual([...picks, pick('me', 'r2')])
  expect(applyPickMirror(picks, 'me', 'room', 'r1', 'retract')).toEqual([pick('other', 'r1')])
})

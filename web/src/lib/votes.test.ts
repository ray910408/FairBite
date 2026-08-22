import { expect, test } from 'vitest'
import { VETO_QUOTA, applyVoteMirror, hasMyVote, myVetoCount, upCounts } from './votes'
import type { VoteRow } from './types'

const vote = (uid: string, rid: string, kind: VoteRow['kind']): VoteRow =>
  ({ room_id: 'room', user_id: uid, restaurant_id: rid, kind })

test('applyVoteMirror cast → 只取代自己同店同 kind，保留另一 kind', () =>
  expect(applyVoteMirror([vote('me', 'r1', 'up'), vote('other', 'r1', 'up')],
    'me', 'room', 'r1', 'veto', 'cast'))
    .toEqual([vote('me', 'r1', 'up'), vote('other', 'r1', 'up'), vote('me', 'r1', 'veto')]))

test('applyVoteMirror cast → 新增一筆，不動他人票', () =>
  expect(applyVoteMirror([vote('other', 'r1', 'veto')], 'me', 'room', 'r1', 'up', 'cast'))
    .toEqual([vote('other', 'r1', 'veto'), vote('me', 'r1', 'up')]))

test('applyVoteMirror retract → 移除該票', () =>
  expect(applyVoteMirror([vote('me', 'r1', 'up'), vote('me', 'r2', 'veto')],
    'me', 'room', 'r1', 'up', 'retract'))
    .toEqual([vote('me', 'r2', 'veto')]))

test('applyVoteMirror retract 不存在的票 → no-op', () =>
  expect(applyVoteMirror([vote('me', 'r1', 'up')], 'me', 'room', 'r1', 'veto', 'retract'))
    .toEqual([vote('me', 'r1', 'up')]))

test('upCounts 只聚合 up，依店分組', () =>
  expect(upCounts([vote('a', 'r1', 'up'), vote('b', 'r1', 'up'),
    vote('a', 'r2', 'veto'), vote('c', 'r2', 'up')]))
    .toEqual({ r1: 2, r2: 1 }))

test('myVetoCount 只算自己的 veto', () =>
  expect(myVetoCount([vote('me', 'r1', 'veto'), vote('me', 'r2', 'up'),
    vote('other', 'r3', 'veto')], 'me')).toBe(1))

test('hasMyVote 分別辨識同店 up 與 veto', () => {
  const votes = [vote('me', 'r1', 'up'), vote('me', 'r1', 'veto')]
  expect(hasMyVote(votes, 'me', 'r1', 'up')).toBe(true)
  expect(hasMyVote(votes, 'me', 'r1', 'veto')).toBe(true)
  expect(hasMyVote(votes, 'other', 'r1', 'up')).toBe(false)
})

// e2e 斷言「否決額度 x/2」字面；額度改動要同步 server/weights.go 與 e2e
test('VETO_QUOTA 鏡本為 2', () => expect(VETO_QUOTA).toBe(2))

import { expect, test } from 'vitest'
import { VETO_QUOTA, applyVoteMirror, myVetoCount, myVoteKind, upCounts } from './votes'
import type { VoteRow } from './types'

const vote = (uid: string, rid: string, kind: VoteRow['kind']): VoteRow =>
  ({ room_id: 'room', user_id: uid, restaurant_id: rid, kind })

test('applyVoteMirror cast → 清掉自己同店另一 kind（鏡射伺服器互斥）', () =>
  expect(applyVoteMirror([vote('me', 'r1', 'up'), vote('other', 'r1', 'up')],
    'me', 'room', 'r1', 'veto', 'cast'))
    .toEqual([vote('other', 'r1', 'up'), vote('me', 'r1', 'veto')]))

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

test('myVoteKind 命中回 kind', () =>
  expect(myVoteKind([vote('me', 'r1', 'veto')], 'me', 'r1')).toBe('veto'))

test('myVoteKind 沒投（或只有別人投）回 null', () =>
  expect(myVoteKind([vote('other', 'r1', 'up')], 'me', 'r1')).toBeNull())

// e2e 斷言「否決額度 x/2」字面；額度改動要同步 server/weights.go 與 e2e
test('VETO_QUOTA 鏡本為 2', () => expect(VETO_QUOTA).toBe(2))

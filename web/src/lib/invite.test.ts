import { describe, expect, it } from 'vitest'
import { buildInviteUrl, normalizeInviteCode } from './invite'

describe('invite links', () => {
  it('normalizes codes and preserves the deployed base path', () => {
    expect(normalizeInviteCode(' ab12cd ')).toBe('AB12CD')
    expect(buildInviteUrl(' ab12cd ', {
      origin: 'https://example.test', pathname: '/fairbite/', search: '?preview=1',
    })).toBe('https://example.test/fairbite/?preview=1#/join/AB12CD')
  })
})

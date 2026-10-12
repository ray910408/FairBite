import { describe, expect, it } from 'vitest'
import { buildInviteUrl, inviteCodeFromLink, normalizeInviteCode } from './invite'

describe('invite links', () => {
  it('normalizes codes and preserves the deployed base path', () => {
    expect(normalizeInviteCode(' ab12cd ')).toBe('AB12CD')
    expect(buildInviteUrl(' ab12cd ', {
      origin: 'https://example.test', pathname: '/fairbite/', search: '?preview=1',
    })).toBe('https://example.test/fairbite/?preview=1#/join/AB12CD')
  })
})

describe('inviteCodeFromLink', () => {
  it('貼上的邀請連結取出 12 碼，貼碼或其他文字回 null', () => {
    const url = buildInviteUrl('a1b2c3d4e5f6', { origin: 'https://x.github.io', pathname: '/FairBite/', search: '' })
    expect(inviteCodeFromLink(url)).toBe('A1B2C3D4E5F6')
    expect(inviteCodeFromLink(`一起決定吃哪家！${url}`)).toBe('A1B2C3D4E5F6')
    expect(inviteCodeFromLink('A1B2C3D4E5F6')).toBeNull()
    expect(inviteCodeFromLink('https://x.github.io/#/join/A1B2C3D4E5F6A')).toBeNull()
  })
})

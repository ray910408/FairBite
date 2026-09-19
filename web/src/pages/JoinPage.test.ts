import { describe, expect, it } from 'vitest'
import { validGuestNickname } from './JoinPage'

describe('guest nickname boundary', () => {
  it('matches the database 80 Unicode-character boundary', () => {
    expect(validGuestNickname('  小明  ')).toBe(true)
    expect(validGuestNickname('😀'.repeat(80))).toBe(true)
    expect(validGuestNickname('😀'.repeat(81))).toBe(false)
    expect(validGuestNickname('   ')).toBe(false)
  })
})

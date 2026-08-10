import { describe, expect, it } from 'vitest'
import { isGoogleSourced } from './placesSource'

describe('isGoogleSourced', () => {
  it('treats mock-prefixed place ids as non-Google', () => {
    expect(isGoogleSourced('mock-noodle-shop')).toBe(false)
  })

  it('treats real place ids as Google-sourced', () => {
    expect(isGoogleSourced('ChIJN1t_tDeuEmsRUsoyG83frY4')).toBe(true)
  })
})

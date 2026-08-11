import { describe, expect, it } from 'vitest'
import { isGoogleSourced } from './placesSource'

describe('isGoogleSourced', () => {
  it('mock 出身不是 Google 來源', () => {
    expect(isGoogleSourced('mock')).toBe(false)
  })

  it('google 出身是 Google 來源', () => {
    expect(isGoogleSourced('google')).toBe(true)
  })

  it('只看 source 欄位：place_id 形狀的輸入不是 Google 來源', () => {
    expect(isGoogleSourced('mock-noodle-shop')).toBe(false)
  })
})

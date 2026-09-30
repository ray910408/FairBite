import { describe, expect, it } from 'vitest'
import { buildMealTimeISO, formatMealTime } from './mealTime'

describe('buildMealTimeISO', () => {
  const now = new Date(2026, 7, 13, 14, 0, 0) // 本地 14:00

  it('接受今天稍晚的時間，回傳當日該時刻的 ISO', () => {
    const r = buildMealTimeISO('19:30', now)
    expect('iso' in r && new Date(r.iso).getHours()).toBe(19)
    expect('iso' in r && new Date(r.iso).getDate()).toBe(13)
  })

  it.each([['13:00'], ['14:00']])('不晚於現在的時間 %s 視為明天', hhmm => {
    const r = buildMealTimeISO(hhmm, now)
    expect('iso' in r && new Date(r.iso).getDate()).toBe(14)
  })

  it('22:35 設 19:30 = 明天 19:30', () => {
    const r = buildMealTimeISO('19:30', new Date(2026, 7, 13, 22, 35, 0))
    expect('iso' in r && new Date(r.iso)).toEqual(new Date(2026, 7, 14, 19, 30, 0))
  })

  it('拒絕格式不對的輸入', () => {
    expect(buildMealTimeISO('', now)).toEqual({ error: '請輸入用餐時間' })
  })

  it('月底近午夜滾到下個月 1 號', () => {
    const r = buildMealTimeISO('00:30', new Date(2026, 7, 31, 23, 50, 0))
    expect('iso' in r && new Date(r.iso)).toEqual(new Date(2026, 8, 1, 0, 30, 0))
  })
})

describe('formatMealTime', () => {
  const now = new Date(2026, 7, 13, 14, 0, 0)

  it('null/undefined 顯示馬上出發', () => {
    expect(formatMealTime(null, now)).toBe('馬上出發')
    expect(formatMealTime(undefined, now)).toBe('馬上出發')
  })
  it('ISO 顯示今天 HH:MM', () => {
    const iso = new Date(2026, 7, 13, 19, 5, 0).toISOString()
    expect(formatMealTime(iso, now)).toBe('今天 19:05')
  })
  it('明天的 ISO 顯示明天 HH:MM', () => {
    const iso = new Date(2026, 7, 14, 19, 30, 0).toISOString()
    expect(formatMealTime(iso, now)).toBe('明天 19:30')
  })
  it('跨日 ISO 顯示 M/D HH:MM', () => {
    const iso = new Date(2026, 7, 12, 19, 30, 0).toISOString()
    expect(formatMealTime(iso, now)).toBe('8/12 19:30')
  })
})

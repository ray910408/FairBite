import { describe, expect, it } from 'vitest'
import { suggestCuisines, type HistoryRow } from './prefsLearning'

const row = (tags: string[], rating: number | null = null): HistoryRow =>
  ({ rating, restaurants: { cuisine_tags: tags } })

const KNOWN = ['japanese', 'korean', 'taiwanese']

describe('suggestCuisines', () => {
  it('吃過 ≥ 2 次且未在偏好中的菜系才建議，按次數排序', () => {
    const rows = [row(['japanese']), row(['japanese']), row(['korean']),
      row(['korean']), row(['korean']), row(['taiwanese'])]
    expect(suggestCuisines(rows, [], KNOWN)).toEqual(['korean', 'japanese'])
  })
  it('已在偏好中的不重複建議', () => {
    expect(suggestCuisines([row(['japanese']), row(['japanese'])], ['japanese'], KNOWN)).toEqual([])
  })
  it('打過低分（≤2 星）的那餐不列入學習', () => {
    expect(suggestCuisines([row(['japanese'], 1), row(['japanese'])], [], KNOWN)).toEqual([])
  })
  it('不在可選清單的 tag 不建議', () => {
    expect(suggestCuisines([row(['noodle']), row(['noodle'])], [], KNOWN)).toEqual([])
  })
  it('最多 3 個', () => {
    const rows = ['japanese', 'korean', 'taiwanese', 'japanese', 'korean', 'taiwanese']
      .map(t => row([t]))
    expect(suggestCuisines([...rows, row(['japanese'])], [],
      [...KNOWN, 'western']).length).toBeLessThanOrEqual(3)
  })
  it('restaurants 為 null 的紀錄跳過', () => {
    const nullRow: HistoryRow = { rating: null, restaurants: null }
    expect(suggestCuisines([nullRow, row(['japanese'])], [], KNOWN)).toEqual([])
  })
})

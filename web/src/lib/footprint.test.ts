import { describe, expect, it } from 'vitest'
import { formatDay, groupByMonth, knownCuisineLabels, summarize, trendRatings, type FootprintRow } from './footprint'

// 日期一律用無時區後綴的本地 ISO：CI 是 UTC，帶 Z 會讓當地時間斷言兩地不同
const row = (over: Partial<FootprintRow>): FootprintRow => ({
  id: 'x', decided_at: '2026-08-10T12:00:00', rating: null,
  restaurants: { name: '店', cuisine_tags: [] }, ...over,
})

describe('summarize', () => {
  it('平均星等只算實評，無實評為 null', () => {
    expect(summarize([row({ rating: 4 }), row({ rating: 2 }), row({})], 3).avgRating).toBe(3)
    expect(summarize([row({})], 1).avgRating).toBeNull()
    expect(summarize([row({ rating: 4 }), row({})], 2).ratedCount).toBe(1)
  })

  it('total 用查詢 count，可大於撈回列數（500 上限）', () => {
    expect(summarize([row({})], 512).total).toBe(512)
  })

  it('菜系分布：未知內部 tag 不計、一店多 tag 全計、次數排序取前 5', () => {
    const rows = [
      row({ restaurants: { name: 'a', cuisine_tags: ['cantonese', 'dimsum'] } }),
      row({ restaurants: { name: 'b', cuisine_tags: ['cantonese'] } }),
      row({ restaurants: { name: 'c', cuisine_tags: ['taiwanese', 'japanese', 'korean', 'hotpot', 'seafood'] } }),
    ]
    const top = summarize(rows, 3).cuisineTop
    expect(top[0]).toEqual(['港式', 2])
    expect(top).toHaveLength(5) // 6 個已知 tag → 截到 5
    expect(top.map(([label]) => label)).not.toContain('dimsum')
  })

  it('餐廳已消失（join null）不炸', () => {
    expect(summarize([row({ restaurants: null })], 1).cuisineTop).toEqual([])
  })
})

describe('trendRatings', () => {
  it('只收實評、反轉為時間正序', () => {
    // 輸入倒序（最新在前）：[5, 未評, 1] → 正序 [1, 5]
    expect(trendRatings([row({ rating: 5 }), row({}), row({ rating: 1 })])).toEqual([1, 5])
  })

  it('超過上限取最近 N 筆', () => {
    const rows = Array.from({ length: 40 }, (_, i) => row({ rating: (i % 5) + 1 }))
    const t = trendRatings(rows, 30)
    expect(t).toHaveLength(30)
    expect(t[29]).toBe(1) // rows[0]（最新，rating=1）在正序尾端
  })
})

describe('groupByMonth', () => {
  it('同月合組、跨月分組、標籤為當地年月', () => {
    const groups = groupByMonth([
      row({ decided_at: '2026-08-10T12:00:00' }),
      row({ decided_at: '2026-08-01T12:00:00' }),
      row({ decided_at: '2026-07-31T12:00:00' }),
    ])
    expect(groups.map(g => [g.label, g.rows.length])).toEqual([
      ['2026 年 8 月', 2], ['2026 年 7 月', 1],
    ])
  })
})

describe('formatDay', () => {
  it('M/D 無補零', () => {
    expect(formatDay('2026-08-05T12:00:00')).toBe('8/5')
  })
})

describe('knownCuisineLabels', () => {
  it('對照已知 tag、丟棄內部 tag、保序', () => {
    expect(knownCuisineLabels(['dimsum', 'cantonese', 'hotpot'])).toEqual(['港式', '火鍋'])
  })
})

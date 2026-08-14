import { describe, expect, it } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import TrendChart, { trendPoints } from './TrendChart'

describe('trendPoints', () => {
  it('少於 2 筆回空（整塊隱藏，spec §5.2）', () => {
    expect(trendPoints([])).toEqual([])
    expect(trendPoints([5])).toEqual([])
  })

  it('★5 貼上緣、★1 貼下緣、x 平均分布（pad=16）', () => {
    const pts = trendPoints([5, 1, 3], 320, 120, 16)
    expect(pts[0]).toEqual({ x: 16, y: 16 })    // ★5 → 頂
    expect(pts[1]).toEqual({ x: 160, y: 104 })  // ★1 → 底
    expect(pts[2]).toEqual({ x: 304, y: 60 })   // ★3 → 中
  })
})

describe('TrendChart markup（renderToStaticMarkup，免 jsdom）', () => {
  it('少於 2 筆輸出空字串（整塊隱藏）', () => {
    expect(renderToStaticMarkup(<TrendChart ratings={[5]} />)).toBe('')
  })

  it('輸出 polyline、資料點、★5／★1 軸標籤與含摘要的 aria-label', () => {
    const html = renderToStaticMarkup(<TrendChart ratings={[5, 1, 3]} />)
    expect(html).toContain('<polyline')
    expect(html).toContain('aria-label="最近 3 筆評分走勢：最早 5 星、最新 3 星、最高 5、最低 1"')
    expect(html).toContain('★5')
    expect(html).toContain('★1')
    expect((html.match(/<circle/g) ?? []).length).toBe(3)
  })
})

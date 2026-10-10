import { expect, test } from 'vitest'
import { restaurantFacts } from './labels'

const r = { name: 'x', lat: 0, lng: 0, place_id: 'p', source: 'google' }

test('候選列顯示評分、價位、菜系，菜系最多兩個', () => {
  expect(restaurantFacts({ ...r, rating: 4.25, price_level: 2, cuisine_tags: ['japanese', 'ramen', 'korean'] }))
    .toEqual(['★4.3', '中等', '日式', '拉麵'])
})

test('Google 沒給的評分、價位與沒有中文名的標籤不顯示', () => {
  expect(restaurantFacts({ ...r, rating: 0, price_level: -1, cuisine_tags: ['vegetarian_friendly', 'hotpot'] }))
    .toEqual(['火鍋'])
  expect(restaurantFacts(r)).toEqual([])
})

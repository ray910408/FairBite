import { expect, test } from 'vitest'
import { restaurantFacts } from './labels'

const r = { name: 'x', lat: 0, lng: 0, place_id: 'p', source: 'google' }

test('候選列顯示評分、價位、菜系，菜系最多兩個', () => {
  expect(restaurantFacts({ ...r, rating: 4.25, price_level: 2, cuisine_tags: ['japanese', 'ramen', 'korean'] }))
    .toEqual(['★4.3', '價位中等', '日式', '拉麵'])
})

test('價位詞本身沒有「價」字才補「價位」，免得緊接星等被讀成評價', () => {
  expect([1, 2, 3, 4].map(price_level => restaurantFacts({ ...r, price_level })))
    .toEqual([['平價'], ['價位中等'], ['價位偏高'], ['高價']])
})

test('Google 的免費層級（0）照樣顯示；沒帶價位才是未知', () => {
  expect(restaurantFacts({ ...r, price_level: 0 })).toEqual(['免費'])
  expect(restaurantFacts({ ...r, price_level: null })).toEqual([])
  expect(restaurantFacts({ ...r, price_level: -1 })).toEqual([])
})

test('Google 沒給的評分、價位與沒有中文名的標籤不顯示', () => {
  expect(restaurantFacts({ ...r, rating: 0, price_level: -1, cuisine_tags: ['vegetarian_friendly', 'hotpot'] }))
    .toEqual(['火鍋'])
  expect(restaurantFacts(r)).toEqual([])
})

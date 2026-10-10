import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { CandidateRow } from '../lib/types'
import CandidateList from './CandidateList'

const row = (id: string, minutes: number, mult: number): CandidateRow => ({
  room_id: 'room', restaurant_id: id, status: 'kept', probability: 0.5,
  weight_breakdown: [
    { factor: 'preference', mult: 0.6, reason: '0/2 位成員偏好命中' },
    { factor: 'distance', mult, reason: `平均交通約 ${minutes} 分鐘` },
    { factor: 'votes', mult: 1, reason: '尚無贊成票' },
  ],
  exclusion_reason: null, exclusion_kinds: [],
  restaurants: { name: id, lat: 25, lng: 121, place_id: id, source: 'google',
    rating: 4.3, price_level: 2, cuisine_tags: ['japanese'] },
})

it('候選列顯示店家資訊，只留會拉開機率的倍率', () => {
  const html = renderToStaticMarkup(<CandidateList rows={[row('a', 1, 1.2), row('b', 5, 1.1)]} />)
  expect(html).toContain('★4.3・價位中等・日式')
  expect(html).toContain('平均交通約 1 分鐘')
  expect(html).toContain('平均交通約 5 分鐘')
  expect(html).not.toContain('偏好命中') // 全場同倍率
  expect(html).not.toContain('尚無贊成票') // ×1.00
})

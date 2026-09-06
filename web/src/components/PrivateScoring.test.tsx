import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import type { CandidateRow, DrawRow } from '../lib/types'
import CandidateList from './CandidateList'
import ResultCard from './ResultCard'
import Wheel from './Wheel'

const candidate: CandidateRow = {
  room_id: 'room', restaurant_id: 'restaurant', status: 'kept', probability: null,
  weight_breakdown: [], exclusion_reason: null, exclusion_kinds: [],
  restaurants: { name: '測試餐廳', lat: 25, lng: 121, place_id: 'place', source: 'google' },
}
const draw: DrawRow = { room_id: 'room', winner_restaurant_id: 'restaurant', seed: 'original-seed', probabilities: {} }

it('does not fabricate zero probability for redacted legacy candidates', () => {
  const html = renderToStaticMarkup(<CandidateList rows={[candidate]} />)
  expect(html).toContain('機率未提供')
  expect(html).not.toContain('0.0%')
})

it('preserves the historical winner without claiming a fabricated probability', () => {
  const html = renderToStaticMarkup(<ResultCard draw={draw} candidates={[candidate]} me={undefined} />)
  expect(html).toContain('測試餐廳')
  expect(html).toContain('歷史機率已隱藏')
  expect(html).not.toContain('0.0%')
})

it('does not draw zero-angle sectors for missing historical odds', () => {
  const html = renderToStaticMarkup(<Wheel rows={[candidate]} winnerId="restaurant" onDone={() => {}} />)
  expect(html).toContain('歷史機率已隱藏')
  expect(html).not.toContain('轉盤抽選中')
})

it('retains normal probability presentation', () => {
  const html = renderToStaticMarkup(<ResultCard draw={{ ...draw, probabilities: { restaurant: 1 } }}
    candidates={[{ ...candidate, probability: 1 }]} me={undefined} />)
  expect(html).toContain('100.0%')
})

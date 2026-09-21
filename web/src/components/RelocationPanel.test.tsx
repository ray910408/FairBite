import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import RelocationPanel from './RelocationPanel'

const props = {
  isHost: false,
  status: 'voting' as const,
  wantChange: true,
  yesCount: 2,
  memberCount: 3,
  busy: false,
  onVote: () => {},
  onChoose: () => {},
}

it('shows a persistent voting checkbox and strict-majority tally', () => {
  const html = renderToStaticMarkup(<RelocationPanel {...props} />)
  expect(html).toContain('我想換地點')
  expect(html).toContain('aria-checked="true"')
  expect(html).toContain('目前 2/3 票，需 2 票才會換地點')
  expect(html).not.toContain('選擇出發點')
})

it('gates the picker by status and host role', () => {
  const waiting = renderToStaticMarkup(<RelocationPanel {...props} status="relocating" />)
  expect(waiting).toContain('等待房主選擇新地點')
  expect(waiting).not.toContain('確認新地點')

  const host = renderToStaticMarkup(<RelocationPanel {...props} isHost status="relocating" />)
  expect(host).toContain('選擇出發點')
  expect(host).toContain('確認新地點')
  expect(host).toContain('disabled=""')
})

it('lets the host edit the center in the lobby', () => {
  const html = renderToStaticMarkup(<RelocationPanel {...props} isHost status="lobby" />)
  expect(html).toContain('調整用餐地點')
  expect(html).toContain('確認用餐地點')
})

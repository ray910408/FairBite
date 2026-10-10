import { renderToStaticMarkup } from 'react-dom/server'
import { expect, it } from 'vitest'
import RelocationPanel, { showLocationConfirm } from './RelocationPanel'

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
  expect(html).not.toContain('確認用餐地點') // 選了新點才出現
})

it('shows the confirm button only when there is something to confirm', () => {
  const current = { lat: 25, lng: 121.5, label: '台北車站' }
  const moved = { lat: 25.01, lng: 121.5, label: '地圖選點' }
  expect(showLocationConfirm('lobby', null, current)).toBe(false)
  expect(showLocationConfirm('lobby', moved, current)).toBe(true)
  expect(showLocationConfirm('lobby', moved, null)).toBe(true) // 本機沒記住現任：選了就能確認
  // 確認成功後現任改寫成同一點：按鈕收起，不再能重送把全員準備歸零
  expect(showLocationConfirm('lobby', moved, { ...moved, label: '已設定' })).toBe(false)
  expect(showLocationConfirm('relocating', null, current)).toBe(true) // 換地點必選，灰著也要在
})

// 首頁選點建房後進 lobby 不得顯示「尚未選擇出發點」：create_room 必帶座標
it('shows the existing lobby center instead of claiming none was chosen', () => {
  const known = renderToStaticMarkup(<RelocationPanel {...props} isHost status="lobby"
    current={{ lat: 25, lng: 121.5, label: '台北車站' }} />)
  expect(known).toContain('台北車站')
  expect(known).not.toContain('尚未選擇出發點')
  expect(known).not.toContain('確認用餐地點') // 沒改點就沒有東西可確認

  const unknown = renderToStaticMarkup(<RelocationPanel {...props} isHost status="lobby" />)
  expect(unknown).toContain('已設定')
  expect(unknown).not.toContain('尚未選擇出發點')

  const relocating = renderToStaticMarkup(<RelocationPanel {...props} isHost status="relocating"
    current={{ lat: 25, lng: 121.5, label: '台北車站' }} />)
  expect(relocating).toContain('尚未選擇出發點')
})

import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyInviteLink, InviteCopyFeedback, InviteQRCode } from './InviteQRCode'

describe('InviteQRCode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('encodes the deployed invite URL and exposes a title', () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test', pathname: '/app/', search: '' } })
    const html = renderToStaticMarkup(<InviteQRCode code="ab12cd" />)
    expect(html).toContain('加入房間 ab12cd')
    expect(html).toContain('用手機相機掃描加入房間')
    expect(html).toContain('<svg')
  })

  it('reports clipboard failure and leaves the copyable URL visible', async () => {
    const url = 'https://example.test/app/#/join/ABC123'
    expect(await copyInviteLink(url, { writeText: vi.fn().mockRejectedValue(new Error('denied')) })).toBe('error')
    const html = renderToStaticMarkup(<InviteCopyFeedback state="error" url={url} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain(url)
  })
})

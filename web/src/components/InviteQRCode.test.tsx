import { renderToStaticMarkup } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { copyInviteLink, InviteCopyFeedback, InviteQRCode, shareInviteLink } from './InviteQRCode'

describe('InviteQRCode', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('encodes the deployed invite URL and exposes a title', () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test', pathname: '/app/', search: '' } })
    const html = renderToStaticMarkup(<InviteQRCode code="ab12cd" />)
    expect(html).toContain('加入房間 ab12cd')
    expect(html).toContain('用手機相機掃描加入房間')
    expect(html).toContain('<svg')
    expect(html).not.toContain('分享邀請連結') // node 的 navigator 沒有 share
  })

  it('offers the system share sheet only where the browser supports it', () => {
    vi.stubGlobal('window', { location: { origin: 'https://example.test', pathname: '/app/', search: '' } })
    vi.stubGlobal('navigator', { share: vi.fn() })
    expect(renderToStaticMarkup(<InviteQRCode code="ab12cd" />)).toContain('分享邀請連結')
  })

  it('reports clipboard failure and leaves the copyable URL visible', async () => {
    const url = 'https://example.test/app/#/join/ABC123'
    expect(await copyInviteLink(url, { writeText: vi.fn().mockRejectedValue(new Error('denied')) })).toBe('error')
    const html = renderToStaticMarkup(<InviteCopyFeedback state="error" url={url} />)
    expect(html).toContain('role="alert"')
    expect(html).toContain(url)
  })

  it('shares through the system sheet; cancel is not an error, other failures fall back to copy', async () => {
    const url = 'https://example.test/app/#/join/ABC123'
    const share = vi.fn().mockResolvedValue(undefined)
    expect(await shareInviteLink(url, 'ABC123', share)).toBe('idle')
    expect(share).toHaveBeenCalledWith(expect.objectContaining({ url }))

    const writeText = vi.fn().mockResolvedValue(undefined)
    const cancel = vi.fn().mockRejectedValue(new DOMException('cancelled', 'AbortError'))
    expect(await shareInviteLink(url, 'ABC123', cancel, { writeText })).toBe('idle')
    expect(writeText).not.toHaveBeenCalled()

    const broken = vi.fn().mockRejectedValue(new DOMException('blocked', 'NotAllowedError'))
    expect(await shareInviteLink(url, 'ABC123', broken, { writeText })).toBe('copied')
    expect(writeText).toHaveBeenCalledWith(url)
  })
})

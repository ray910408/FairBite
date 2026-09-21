import { QRCodeSVG } from 'qrcode.react'
import { useState } from 'react'
import { buildInviteUrl } from '../lib/invite'

type CopyState = 'idle' | 'copied' | 'error'

export async function copyInviteLink(url: string, clipboard: Pick<Clipboard, 'writeText'> = navigator.clipboard): Promise<CopyState> {
  try {
    await clipboard.writeText(url)
    return 'copied'
  } catch {
    return 'error'
  }
}

export function InviteCopyFeedback({ state, url }: { state: CopyState; url: string }) {
  if (state === 'copied') return <p role="status" className="text-xs text-brand-strong">邀請連結已複製</p>
  if (state === 'error') return <p role="alert" className="text-xs text-danger">無法複製，請手動分享網址：{url}</p>
  return null
}

export function InviteQRCode({ code }: { code: string }) {
  const url = buildInviteUrl(code)
  const [copyState, setCopyState] = useState<CopyState>('idle')
  return (
    <div className="flex flex-col items-center gap-2">
      <QRCodeSVG value={url} size={176} marginSize={2} title={`加入房間 ${code}`} />
      <p className="text-center text-xs text-fg-muted">用手機相機掃描加入房間</p>
      <button type="button" className="btn btn-quiet w-full"
        onClick={async () => setCopyState(await copyInviteLink(url))}>複製邀請連結</button>
      <InviteCopyFeedback state={copyState} url={url} />
    </div>
  )
}

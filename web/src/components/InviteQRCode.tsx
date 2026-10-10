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

// 手機的系統分享面板一鍵丟 LINE；使用者取消不算失敗，其他失敗退回複製
export async function shareInviteLink(url: string, code: string,
  share: Navigator['share'] = data => navigator.share(data),
  clipboard?: Pick<Clipboard, 'writeText'>): Promise<CopyState> {
  try {
    await share({ title: '今天吃什麼', text: `一起決定吃哪家！邀請碼 ${code}`, url })
    return 'idle'
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') return 'idle'
    return copyInviteLink(url, clipboard)
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
  const canShare = typeof navigator !== 'undefined' && typeof navigator.share === 'function'
  return (
    <div className="flex flex-col items-center gap-2">
      {/* 唯一允許的 raw 色：QR 必須淺底深碼＋白色 quiet zone，深色主題反相會讓相機掃不到 */}
      <div className="rounded-btn border border-border bg-white p-2">
        <QRCodeSVG value={url} size={176} marginSize={2} title={`加入房間 ${code}`} />
      </div>
      <p className="text-center text-xs text-fg-muted">用手機相機掃描加入房間</p>
      {/* px-2：320px 卡片內兩顆並排各約 123px，預設 px-4 會把六個字擠到換行 */}
      <div className="grid w-full auto-cols-fr grid-flow-col gap-2">
        {canShare && (
          <button type="button" className="btn btn-primary px-2"
            onClick={async () => setCopyState(await shareInviteLink(url, code))}>分享邀請連結</button>
        )}
        <button type="button" className="btn btn-quiet px-2"
          onClick={async () => setCopyState(await copyInviteLink(url))}>複製邀請連結</button>
      </div>
      <InviteCopyFeedback state={copyState} url={url} />
    </div>
  )
}

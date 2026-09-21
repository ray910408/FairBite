import { Link } from 'react-router-dom'
import { useState } from 'react'

export function guestRegistrationDismissKey(userId: string) {
  return `guest-registration-dismissed:${userId}`
}

function wasDismissed(userId: string) {
  try { return localStorage.getItem(guestRegistrationDismissKey(userId)) === '1' } catch { return false }
}

export function GuestRegistrationPrompt({ userId, roomId, open }: { userId: string; roomId: string; open: boolean }) {
  const [dismissed, setDismissed] = useState(() => wasDismissed(userId))
  if (!open || dismissed) return null
  const dismiss = () => {
    try { localStorage.setItem(guestRegistrationDismissKey(userId), '1') } catch { /* state still hides it */ }
    setDismissed(true)
  }
  return (
    <section className="card space-y-3" aria-labelledby="guest-registration-title">
      <h2 id="guest-registration-title" className="text-base font-semibold">保留這次聚餐紀錄？</h2>
      <p className="text-sm text-fg-muted">註冊後會保留目前訪客身分的房籍與用餐紀錄。</p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <button autoFocus type="button" className="btn btn-quiet flex-1" onClick={dismiss}>這次先不要</button>
        <Link className="btn btn-primary flex-1" to="/auth?mode=register"
          onClick={() => sessionStorage.setItem(`guest-upgrade-return:${userId}`, `/room/${roomId}`)}>
          註冊並保留紀錄
        </Link>
      </div>
    </section>
  )
}

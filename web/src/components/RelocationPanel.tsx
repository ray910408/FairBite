import { useState } from 'react'
import type { DeparturePoint } from '../lib/departure'
import LocationPicker from './LocationPicker'

type Props = {
  isHost: boolean
  status: 'lobby' | 'voting' | 'relocating'
  wantChange: boolean
  yesCount: number
  memberCount: number
  busy: boolean
  onVote: (want: boolean) => void
  onChoose: (point: DeparturePoint) => void
}

export default function RelocationPanel({
  isHost, status, wantChange, yesCount, memberCount, busy, onVote, onChoose,
}: Props) {
  const [point, setPoint] = useState<DeparturePoint | null>(null)
  const majority = Math.floor(memberCount / 2) + 1

  if (status === 'voting') {
    return (
      <section className="card space-y-2" aria-labelledby="relocation-vote-title">
        <h2 id="relocation-vote-title" className="text-base font-semibold">要改用餐地點嗎？</h2>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={wantChange}
            aria-checked={wantChange} disabled={busy}
            onChange={e => onVote(e.target.checked)} />
          <span>我想換地點</span>
        </label>
        <p className="text-xs text-fg-muted">目前 {yesCount}/{memberCount} 票，需 {majority} 票才會換地點</p>
      </section>
    )
  }

  if (!isHost) {
    return status === 'relocating' ? (
      <section className="card space-y-2" aria-live="polite">
        <p className="text-sm text-fg-muted">等待房主選擇新地點</p>
      </section>
    ) : null
  }

  return (
    <section className="card space-y-3" aria-labelledby="relocation-picker-title">
      <h2 id="relocation-picker-title" className="text-base font-semibold">
        {status === 'relocating' ? '選擇新地點' : '調整用餐地點'}
      </h2>
      <LocationPicker value={point} onChange={setPoint} />
      <button type="button" className="btn btn-primary min-h-11 w-full"
        disabled={busy || !point} onClick={() => point && onChoose(point)}>
        {status === 'relocating' ? '確認新地點' : '確認用餐地點'}
      </button>
    </section>
  )
}

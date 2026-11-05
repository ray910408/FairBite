import { useState } from 'react'
import type { DeparturePoint } from '../lib/departure'
import { strictMajority } from '../lib/shortlist'
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
  // 本機記得的現任出發點（departure.ts loadRoomDeparture）；只在 lobby 顯示
  current?: DeparturePoint | null
  // rooms.has_location：發起時沒帶出發點、還沒選過就是 false（只在 lobby 有意義）
  hasLocation: boolean
}

// 確認鈕只在有東西可確認時出現：換地點一定要選新點；lobby 要選了和現任不同的點。
// 現任＝本機記得的出發點，確認成功後 saveRoomDeparture 寫入 → 按鈕自動收起，
// 不留一顆再按就把全員準備歸零的按鈕（relocation.go 會遞增 search_version）
export function showLocationConfirm(status: Props['status'], point: DeparturePoint | null,
  current: DeparturePoint | null) {
  if (status === 'relocating') return true
  return point !== null && (point.lat !== current?.lat || point.lng !== current?.lng)
}

export default function RelocationPanel({
  isHost, status, wantChange, yesCount, memberCount, busy, onVote, onChoose, current = null, hasLocation,
}: Props) {
  const [point, setPoint] = useState<DeparturePoint | null>(null)
  // mount 時讀一次：current 每次 render 都是新 parse 的物件，直接往下傳會讓
  // LocationPicker 的 [value] effect 在每次 Realtime refetch 把展開中的地圖拉回原點
  const [initial] = useState(current)
  const majority = strictMajority(memberCount)

  if (status === 'voting') {
    return (
      <section className="card space-y-2" aria-labelledby="relocation-vote-title">
        <h2 id="relocation-vote-title" className="text-base font-semibold">要改用餐地點嗎？</h2>
        <label className="flex min-h-11 items-center gap-3 text-sm">
          <input type="checkbox" className="h-5 w-5 accent-brand" checked={wantChange}
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
        <p className="text-sm text-fg-muted">等待發起人選擇新地點</p>
      </section>
    ) : null
  }

  return (
    <section className="card space-y-3" aria-labelledby="relocation-picker-title">
      <h2 id="relocation-picker-title" className="text-base font-semibold">
        {status === 'relocating' ? '選擇新地點' : hasLocation ? '調整用餐地點' : '選擇用餐地點'}
      </h2>
      {/* lobby 已有出發點時（發起時帶了，或之前選過）不能講「尚未選擇」，換裝置讀不到地名就講「已設定」；
          發起時沒帶的 lobby 才是真的還沒選。relocating 則必須選新點，舊點不算數 */}
      <LocationPicker value={point ?? (status === 'lobby' && hasLocation ? initial : null)} onChange={setPoint}
        fallbackLabel={status === 'lobby' && hasLocation ? '已設定' : undefined} />
      {/* lobby 沒改點就沒有東西可確認：不擺一顆灰掉的主按鈕在房主第一眼的位置 */}
      {showLocationConfirm(status, point, current) && (
        <button type="button" className="btn btn-primary min-h-11 w-full"
          disabled={busy || !point} onClick={() => point && onChoose(point)}>
          {status === 'relocating' ? '確認新地點' : '確認用餐地點'}
        </button>
      )}
    </section>
  )
}

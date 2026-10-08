import type { CandidateRow, DrawRow, MemberRow } from '../lib/types'
import { buildMapsUrl } from '../lib/maps'
import { formatPercent } from '../lib/probability'
import { TRANSPORT_LABELS } from '../lib/labels'
import { MapPin } from './icons'

// 雙框朱印：外框 3px、內縮 2px 再一圈細線；250ms 後才蓋下（等卡片浮現）
const STAMP = 'absolute top-3.5 right-4 flex items-center justify-center rounded-[4px] border-[3px] border-brand font-serif font-black text-brand animate-stamp'
const STAMP_STYLE = {
  boxShadow: 'inset 0 0 0 2px var(--color-surface), inset 0 0 0 3.5px var(--color-brand)',
  animationDelay: '250ms',
}

export default function ResultCard({ draw, candidates, me, confirmed = true }: {
  draw: DrawRow
  candidates: CandidateRow[]
  me: MemberRow | undefined
  confirmed?: boolean
}) {
  const winner = candidates.find(c => c.restaurant_id === draw.winner_restaurant_id)
  if (!winner) return null
  const r = winner.restaurants
  const prob = draw.probabilities[draw.winner_restaurant_id]
  return (
    // overflow-hidden：印章 delay 期間停在 scale(2.4) 的起始幀，不裁的話會撐出約 47px 水平捲動
    <div className="card menu-frame relative flex animate-rise flex-col gap-2.5 overflow-hidden rounded-btn px-4.5 pt-5 pb-4">
      {/* 朱印：定案時「今天就吃」就是標題前的那行字（不 aria-hidden）；待確認時只是裝飾，文字留給下方 eyebrow */}
      {confirmed ? (
        <span className={`${STAMP} size-18`} style={STAMP_STYLE}>
          <span className="h-11 text-xl leading-[1.05] [writing-mode:vertical-rl]">今天就吃</span>
        </span>
      ) : (
        <span aria-hidden="true" className={`${STAMP} size-[62px] text-[22px] leading-none tracking-[0.05em] [writing-mode:vertical-rl]`}
          style={STAMP_STYLE}>抽中</span>
      )}
      {/* min-h 與 pr-20 讓店名和下方內容都避開印章（含 -10deg 旋轉後的外擴） */}
      <div className="flex min-h-18 flex-col justify-center gap-2.5 pr-20">
        {!confirmed && <p className="text-xs tracking-[0.35em] text-brand">抽中待確認</p>}
        <h2 className="text-3xl leading-tight font-black wrap-anywhere">{r.name}</h2>
      </div>
      <p className="text-sm text-fg-muted">
        {prob == null ? '歷史機率已隱藏，以保護成員隱私；原抽選結果保留' : <>
          抽中機率 <span className="font-serif text-[15px] font-bold text-fg">{formatPercent(prob)}</span>
        </>}
      </p>
      <a className={`btn ${confirmed ? 'btn-primary' : 'btn-secondary'} mt-1 w-full text-sm tracking-[0.05em]`}
        href={buildMapsUrl(r.lat, r.lng, r.place_id, r.source, me?.transport ?? 'walking')}
        target="_blank" rel="noreferrer">
        <MapPin className="h-4.5 w-4.5" />
        從目前位置用 Google Maps 導航（{TRANSPORT_LABELS[me?.transport ?? 'walking']}）
      </a>
    </div>
  )
}

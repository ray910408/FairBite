import { useRef } from 'react'
import type { CandidateRow } from '../lib/types'
import { buildGoogleMapsPlaceUrl } from '../lib/maps'
import { isGoogleSourced } from '../lib/placesSource'
import { restaurantFacts } from '../lib/labels'
import { chipLabel, decisiveFactors, formatPercents, sortExcluded, sortKept } from '../lib/probability'
import { SHORTLIST_PICK_MAX, SHORTLIST_PICK_MIN } from '../lib/shortlist'
import { VETO_QUOTA } from '../lib/votes'
import { ArrowDown, ArrowUp, Chevron } from './icons'

// 純顯示：票數/我的票/剩餘額度都由 useRoom 算好傳入，這裡不碰 raw votes
type VotingProps = {
  hasMyVote: (rid: string, kind: 'up' | 'veto') => boolean
  ups: Record<string, number>
  vetoesRemaining: number
  onToggle: (restaurantId: string, kind: 'up' | 'veto') => void
}

// 初選圈選（ADR-0010）：圈選只決定去留，不動機率顯示；counts 是各店被幾人圈選（公開）
type PickingProps = {
  isPicked: (rid: string) => boolean
  counts: Record<string, number>
  myCount: number
  onToggle: (restaurantId: string) => void
}

// 被否決的店（可能同時有別的排除原因）：投票中留在原位，不收進「被排除」
const isVetoed = (c: CandidateRow) => c.status === 'excluded' && c.exclusion_kinds?.includes('veto')

export default function CandidateList({ rows, voting, picking }: {
  rows: CandidateRow[]; voting?: VotingProps; picking?: PickingProps
}) {
  const kept = sortKept(rows)
  const oddsKnown = kept.every(c => c.probability != null)
  const percents = formatPercents(kept.map(c => c.probability ?? 0))
  const percentOf = new Map(kept.map((c, i) => [c.restaurant_id, percents[i]]))
  // 投票中順序固定：機率隨贊成即時變、被否決的店離開清單，各列一挪動，下一下就按到別家。
  // 順序在進入投票時定下（換階段時 RoomPage 會重新掛載本元件），之後只有沒見過的店排到最後。
  // 重整後會依當下機率重新定序，這時已被否決的店排在最後。
  // 候選還沒載到（空清單）時不定序：凍結成空陣列就再也不會重定，所有店都變成「沒見過」
  const votingOrder = useRef<string[] | null>(null)
  if (voting && !votingOrder.current?.length) {
    votingOrder.current = [...kept, ...rows.filter(isVetoed)].map(c => c.restaurant_id)
  }
  const rank = (c: CandidateRow) => {
    const i = votingOrder.current?.indexOf(c.restaurant_id) ?? -1
    return i < 0 ? Infinity : i
  }
  const listed = voting
    ? rows.filter(c => c.status === 'kept' || isVetoed(c))
      .sort((a, b) => rank(a) - rank(b) || (b.probability ?? 0) - (a.probability ?? 0))
    : kept
  const excluded = sortExcluded(rows).filter(c => !voting || !isVetoed(c))
  const max = Math.max(...kept.map(c => c.probability ?? 0), 0.0001)
  const decisive = decisiveFactors(kept)
  const showGoogleAttribution = rows.some(c => isGoogleSourced(c.restaurants.source))

  // 精簡按鈕：btn-primary 本身沒邊框，補框才不會和 btn-quiet 切換時寬度跳 2px。
  // 框用 brand 而非 brand-fill：深色時 brand-fill 對 surface 只有 2.07:1，按下與否要靠亮框分辨
  // shrink-0 + nowrap：≤360px 時按鈕不被擠成一字一行；整列不 wrap，改由左側連結自己折行，贊成／否決才不會被拆開
  const actionBtn = 'btn shrink-0 whitespace-nowrap px-3.5 text-sm tracking-widest'
  const pressedBtn = 'btn-primary border border-brand'
  // 逐行浮現的錯開上限：候選可超過 20 家，換階段 remount 或投票重排時不讓後面的列空白好幾秒
  const stagger = (ci: number) => Math.min(ci, 8) * 120

  return (
    <div className="space-y-2">
      <section className="menu-frame px-4 pt-5 pb-1">
        <div className="text-center">
          <h2 className="font-serif text-[22px] font-black tracking-[0.08em]">候選餐廳（{kept.length}）</h2>
          {voting && (
            <p className="mt-0.5 text-xs text-fg-muted">否決額度 {voting.vetoesRemaining}/{VETO_QUOTA}（可收回）</p>
          )}
          {picking && (
            <p className="mt-0.5 text-xs text-fg-muted">已圈 {picking.myCount}/{SHORTLIST_PICK_MAX}（至少 {SHORTLIST_PICK_MIN} 家）</p>
          )}
        </div>
        <ul className="mt-3">
          {listed.map((c, ci) => {
            // 和候選列共用同一個 <li>（同 key、同位置）：animate-row-in 與 delay 也要一樣，
            // animation-name 不變，否決／收回時這一列才不會先透明再重新浮現
            if (voting && isVetoed(c)) return (
              <li key={c.restaurant_id} data-testid="vetoed-row"
                className="flex animate-row-in flex-col gap-1.5 border-t border-border px-1 py-3.5 text-fg-muted"
                style={{ animationDelay: `${stagger(ci)}ms` }}>
                <div className="flex items-baseline gap-2 font-serif">
                  <span aria-hidden="true" className="text-[13px] font-bold">{String(ci + 1).padStart(2, '0')}</span>
                  <span className="min-w-0 text-[17px] font-bold line-through decoration-brand decoration-[1.5px]">
                    {c.restaurants.name}
                  </span>
                </div>
                <div className="flex flex-wrap items-center justify-end gap-x-3 gap-y-1">
                  <span className="mr-auto text-xs">{c.exclusion_reason}</span>
                  {voting.hasMyVote(c.restaurant_id, 'veto') && (
                    <button type="button" className={`${actionBtn} btn-quiet`}
                      onClick={() => voting.onToggle(c.restaurant_id, 'veto')}>
                      收回否決
                    </button>
                  )}
                </div>
              </li>
            )
            const google = isGoogleSourced(c.restaurants.source)
            const facts = restaurantFacts(c.restaurants)
            const factors = c.weight_breakdown.filter(decisive)
            return (
              <li key={c.restaurant_id} data-testid="candidate-row"
                className="flex animate-row-in flex-col gap-2 border-t border-border px-1 py-3.5"
                style={{ animationDelay: `${stagger(ci)}ms` }}>
                <div className="flex items-baseline gap-2 font-serif">
                  <span aria-hidden="true" className="text-[13px] font-bold text-brand">{String(ci + 1).padStart(2, '0')}</span>
                  <span data-testid="candidate-name" className="min-w-0 text-[17px] font-bold">{c.restaurants.name}</span>
                  {voting?.hasMyVote(c.restaurant_id, 'up') && (
                    <span aria-hidden="true"
                      className="inline-flex h-5 w-5 shrink-0 animate-stamp-sm items-center justify-center self-center rounded-[2px] border-[1.5px] border-brand text-[11px] font-black text-brand"
                      style={{ animationDelay: '200ms' }}>
                      贊
                    </span>
                  )}
                  <span aria-hidden="true" className="leader origin-left animate-lead"
                    style={{ animationDelay: `${stagger(ci) + 200}ms` }} />
                  <span className={`shrink-0 font-bold ${oddsKnown ? 'text-[17px]' : 'text-sm text-fg-muted'}`}>
                    {oddsKnown ? percentOf.get(c.restaurant_id) : '機率未提供'}
                  </span>
                </div>
                {oddsKnown && <div aria-hidden="true" className="h-[3px] bg-brand-soft">
                  <div className="h-full bg-brand transition-[width] duration-300 ease-out"
                    style={{ width: `${((c.probability ?? 0) / max) * 100}%` }} />
                </div>}
                {facts.length > 0 && <p className="text-[13px]">{facts.join('・')}</p>}
                {factors.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] leading-relaxed">
                    {factors.map((e, i) => (
                      <span key={i}
                        className={`inline-flex items-center gap-[3px] ${
                          e.mult > 1 ? 'text-ok' : 'text-warn' // 倍率恰為 1 的已由 decisiveFactors 濾掉
                        }`}>
                        {e.mult > 1 && <ArrowUp className="h-[11px] w-[11px] shrink-0" />}
                        {e.mult < 1 && <ArrowDown className="h-[11px] w-[11px] shrink-0" />}
                        {chipLabel(e)}
                      </span>
                    ))}
                  </div>
                )}
                {(google || voting || picking) && (
                  <div className="flex items-center justify-end gap-1.5">
                    {google && (
                      <a
                        className="mr-auto text-xs text-brand underline underline-offset-[3px]"
                        href={buildGoogleMapsPlaceUrl(c.restaurants.name, c.restaurants.lat, c.restaurants.lng,
                          c.restaurants.place_id, c.restaurants.source)}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        在 Google Maps 查看
                      </a>
                    )}
                    {voting && (
                      <>
                        <button type="button" aria-pressed={voting.hasMyVote(c.restaurant_id, 'up')}
                          className={`${actionBtn} ${voting.hasMyVote(c.restaurant_id, 'up') ? pressedBtn : 'btn-quiet'}`}
                          onClick={() => voting.onToggle(c.restaurant_id, 'up')}>
                          贊成{(voting.ups[c.restaurant_id] ?? 0) > 0 ? `（${voting.ups[c.restaurant_id]}）` : ''}
                        </button>
                        <button type="button" aria-pressed={voting.hasMyVote(c.restaurant_id, 'veto')}
                          disabled={!voting.hasMyVote(c.restaurant_id, 'veto') && voting.vetoesRemaining <= 0}
                          className={`${actionBtn} btn-quiet text-danger disabled:opacity-40`}
                          onClick={() => voting.onToggle(c.restaurant_id, 'veto')}>
                          否決
                        </button>
                      </>
                    )}
                    {picking && (
                      <button type="button" aria-pressed={picking.isPicked(c.restaurant_id)}
                        disabled={!picking.isPicked(c.restaurant_id) && picking.myCount >= SHORTLIST_PICK_MAX}
                        className={`${actionBtn} disabled:opacity-40 ${picking.isPicked(c.restaurant_id) ? pressedBtn : 'btn-quiet'}`}
                        onClick={() => picking.onToggle(c.restaurant_id)}>
                        圈選{(picking.counts[c.restaurant_id] ?? 0) > 0 ? `（${picking.counts[c.restaurant_id]} 人）` : ''}
                      </button>
                    )}
                  </div>
                )}
              </li>
            )
          })}
        </ul>
        {excluded.length > 0 && (
          <details className="border-t border-border px-1 pb-2">
            <summary className="flex min-h-11 list-none items-center gap-2 font-serif text-sm font-bold text-fg-muted [&::-webkit-details-marker]:hidden">
              <Chevron className="disclosure-chevron h-4 w-4" />
              被排除的 {excluded.length} 家
            </summary>
            <ul className="space-y-1">
              {excluded.map(c => (
                // flex-wrap：原因很長（Google 價位層級說明）時整段換到下一行，店名不被擠成一字一行
                <li key={c.restaurant_id} className="flex flex-wrap items-baseline gap-x-3 gap-y-0.5 text-[13px] text-fg-muted">
                  <span className="font-serif line-through decoration-brand decoration-[1.5px]">{c.restaurants.name}</span>
                  <span className="ml-auto text-right text-xs">{c.exclusion_reason}</span>
                </li>
              ))}
            </ul>
          </details>
        )}
      </section>
      {showGoogleAttribution && (
        // Google Places 歸屬字級下限 12sp，不能低於 text-xs
        <p className="text-center text-xs text-fg-muted">餐廳資料 Powered by Google</p>
      )}
      {rows.some(c => c.weight_breakdown.some(e => e.factor === 'weather')) && (
        <p className="text-center text-xs text-fg-muted">天氣資料 Open-Meteo.com（CC BY 4.0）</p>
      )}
    </div>
  )
}

import type { CandidateRow } from '../lib/types'
import { buildGoogleMapsPlaceUrl } from '../lib/maps'
import { isGoogleSourced } from '../lib/placesSource'
import { chipLabel, formatPercents, sortExcluded, sortKept } from '../lib/probability'
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

export default function CandidateList({ rows, voting, picking }: {
  rows: CandidateRow[]; voting?: VotingProps; picking?: PickingProps
}) {
  const kept = sortKept(rows)
  const oddsKnown = kept.every(c => c.probability != null)
  const percents = formatPercents(kept.map(c => c.probability ?? 0))
  const excluded = sortExcluded(rows)
  const max = Math.max(...kept.map(c => c.probability ?? 0), 0.0001)
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
          {kept.map((c, ci) => {
            const google = isGoogleSourced(c.restaurants.source)
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
                    {oddsKnown ? percents[ci] : '機率未提供'}
                  </span>
                </div>
                {oddsKnown && <div aria-hidden="true" className="h-[3px] bg-brand-soft">
                  <div className="h-full bg-brand"
                    style={{ width: `${((c.probability ?? 0) / max) * 100}%` }} />
                </div>}
                {c.weight_breakdown.length > 0 && (
                  <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-[12.5px] leading-relaxed">
                    {c.weight_breakdown.map((e, i) => (
                      <span key={i}
                        className={`inline-flex items-center gap-[3px] ${
                          e.mult > 1 ? 'text-ok' : e.mult < 1 ? 'text-warn' : 'text-fg-muted'
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
          <details className="border-t border-border px-1 pb-2" open={voting != null}>
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
                  {voting && voting.hasMyVote(c.restaurant_id, 'veto') && (
                    <button type="button" className="btn btn-quiet shrink-0 px-2 py-1 text-xs"
                      onClick={() => voting.onToggle(c.restaurant_id, 'veto')}>
                      收回否決
                    </button>
                  )}
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

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatDay, groupByMonth, knownCuisineLabels, summarize, trendRatings, type FootprintRow } from '../lib/footprint'
import { Logo, Spinner, Star } from '../components/icons'
import StarRow from '../components/StarRow'
import TrendChart from '../components/TrendChart'

// 足跡頁（spec 2026-08-14）：同席紀錄的個人視圖。單一查詢直讀 Supabase
//（RLS 只回自己的列），統計全在前端現算；補評成功只更新本地列，不 refetch。
type LoadState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; rows: FootprintRow[]; total: number }

export default function HistoryPage() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  // 未評列補評 chip 的展開狀態（一次一列，design review D4）
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const expandedLiRef = useRef<HTMLLIElement | null>(null)
  const requestGen = useRef(0)

  const load = useCallback(async () => {
    const request = ++requestGen.current
    setState({ phase: 'loading' })
    // count:'exact' 回全表符合數（不受 limit 影響）——總餐數不被 500 上限謊報（決策 #8）
    const { data, error, count } = await supabase.from('dining_history')
      .select('id, decided_at, rating, restaurants(name, cuisine_tags)', { count: 'exact' })
      .order('decided_at', { ascending: false })
      .limit(500)
    // 舊回應作廢（HomePage suggestionRequest 同款模式）：StrictMode 雙掛載或重試競態下，
    // 晚到的舊資料不得覆蓋新狀態（尤其剛 onRated 的本地補列）
    if (request !== requestGen.current) return
    if (error) setState({ phase: 'error' })
    else {
      const rows = (data ?? []) as unknown as FootprintRow[]
      setState({ phase: 'ready', rows, total: count ?? rows.length })
    }
  }, [])

  useEffect(() => {
    void load()
    return () => { requestGen.current++ } // unmount 作廢 in-flight 回應
  }, [load])

  const onRated = useCallback((id: string, n: number) => {
    setState(prev => prev.phase === 'ready'
      ? { ...prev, rows: prev.rows.map(r => r.id === id ? { ...r, rating: n } : r) }
      : prev)
    // 星排卸載後焦點會憑空消失（鍵盤／報讀中斷）——收合前抓住該列，把焦點移回去（design review S8）
    const li = expandedLiRef.current
    setExpandedId(null)
    requestAnimationFrame(() => li?.focus())
  }, [])

  const rows = state.phase === 'ready' ? state.rows : []
  const total = state.phase === 'ready' ? state.total : 0
  const summary = useMemo(() => summarize(rows, total), [rows, total])
  const ratings = useMemo(() => trendRatings(rows), [rows])
  const groups = useMemo(() => groupByMonth(rows), [rows])

  return (
    <div className="min-h-screen">
      {/* 品牌列比照 HomePage（h1 歸位到 main，design review D3）；sticky 比照 RoomPage——
          本頁是全 app 最長可捲頁，捲深後「回首頁」不得消失（design review D8） */}
      <header className="sticky top-0 z-20 border-b border-border bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-md items-center justify-between p-4">
          <div className="flex items-center gap-2">
            <Logo className="h-8 w-8" />
            <span className="text-lg font-bold">今天吃什麼</span>
          </div>
          <Link to="/" className="btn btn-quiet min-h-11 px-3 text-sm">回首頁</Link>
        </div>
      </header>

      <main className="mx-auto w-full max-w-md space-y-4 p-4">
        {state.phase === 'loading' && (
          <div className="flex flex-col items-center gap-3 p-8 text-fg-muted">
            <Spinner className="h-7 w-7 text-brand" />
            <p className="text-sm">載入中…</p>
          </div>
        )}

        {state.phase === 'error' && (
          <section className="card space-y-3 text-center">
            <p role="alert" className="text-sm text-danger">足跡載入失敗</p>
            <button type="button" className="btn btn-quiet min-h-11 px-4 text-sm"
              onClick={() => void load()}>
              重試
            </button>
          </section>
        )}

        {state.phase === 'ready' && total === 0 && (
          <section className="card animate-rise space-y-3 text-center">
            <Logo className="mx-auto h-12 w-12 opacity-60" />
            <p className="text-sm font-semibold">還沒有足跡</p>
            <p className="text-sm text-fg-muted">開一場聚餐決策，定案後這裡就會留下紀錄。</p>
            <Link to="/" className="btn btn-primary min-h-11 px-4 text-sm">回首頁開一場</Link>
          </section>
        )}

        {state.phase === 'ready' && total > 0 && (
          <>
            {/* hero 彙總卡（design review D3）：比照 HomePage 開場卡／ResultCard 的
                brand-soft 漸層；h1 入卡、總餐數為唯一主數字，已評／平均降次要 */}
            <section className="card animate-rise space-y-3 bg-linear-to-b from-brand-soft to-surface">
              <h1 className="text-2xl font-bold tracking-tight">足跡</h1>
              <div>
                <p className="text-3xl font-bold">
                  {summary.total} <span className="text-base font-semibold">餐</span>
                </p>
                <p className="text-sm text-fg-muted">
                  已評 {summary.ratedCount} 筆
                  {summary.avgRating !== null && ` · 平均 ${summary.avgRating.toFixed(1)} ★`}
                </p>
                {rows.length < total && (
                  <p className="mt-1 text-xs text-fg-muted">
                    總餐數為全部紀錄；其餘統計依最近 {rows.length} 筆
                  </p>
                )}
              </div>
              {summary.cuisineTop.length > 0 && (
                <div className="space-y-1">
                  <h2 className="text-sm font-semibold text-fg-muted">常吃菜系</h2>
                  {summary.cuisineTop.map(([label, n]) => (
                    <div key={label} className="flex items-center gap-2 text-sm">
                      <span className="w-12 shrink-0">{label}</span>
                      <div className="h-2 flex-1 rounded-full bg-brand-soft">
                        <div className="h-2 rounded-full bg-brand"
                          style={{ width: `${(n / summary.cuisineTop[0][1]) * 100}%` }} />
                      </div>
                      <span className="w-6 shrink-0 text-right text-xs text-fg-muted">{n}</span>
                    </div>
                  ))}
                </div>
              )}
            </section>

            {/* 走勢＝無框 section（design review D3）；實評 1→2 筆時本區塊會在捲動位置上方
                突現——已知行為，瀏覽器 scroll anchoring 緩解，不特別處理（design review D10） */}
            {ratings.length >= 2 && (
              <section className="space-y-2">
                <h2 className="text-sm font-semibold text-fg-muted">
                  評分走勢（最近 {ratings.length} 筆實評）
                </h2>
                <TrendChart ratings={ratings} />
              </section>
            )}

            {/* 時間軸清單＝連續 divide-y 列，不逐列包卡（design review D3：
                500 筆級清單要時間軸節奏，不要卡片 feed） */}
            {groups.map(g => (
              <section key={g.label} className="space-y-1">
                <h2 className="text-sm font-semibold text-fg-muted">{g.label}</h2>
                <ul className="divide-y divide-border">
                  {g.rows.map(r => (
                    <li key={r.id} tabIndex={-1}
                      ref={r.id === expandedId ? expandedLiRef : undefined}
                      className="space-y-2 py-3">
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate font-semibold">
                            {r.restaurants?.name ?? '（餐廳已下架）'}
                          </p>
                          <div className="mt-0.5 flex flex-wrap items-center gap-1 text-xs text-fg-muted">
                            <span>{formatDay(r.decided_at)}</span>
                            {knownCuisineLabels(r.restaurants?.cuisine_tags ?? [])
                              .slice(0, 3).map(label => (
                                <span key={label} className="rounded-full bg-brand-soft px-2 py-0.5">
                                  {label}
                                </span>
                              ))}
                          </div>
                        </div>
                        {r.rating !== null && (
                          <span role="img" aria-label={`已評 ${r.rating} 顆星`}
                            className="flex shrink-0 items-center gap-0.5 text-brand">
                            {Array.from({ length: r.rating }, (_, i) => (
                              <Star key={i} className="h-4 w-4" />
                            ))}
                          </span>
                        )}
                      </div>
                      {/* 未評列：預設收合為「補評」chip，點擊才展開（design review D4——
                          推翻 grilled「免展開」：積壓多筆時整頁會變待辦清單；
                          .chip 是既有可點篩選元件 class，44px 觸控目標內建） */}
                      {r.rating === null && (
                        expandedId === r.id ? (
                          <div role="group" aria-label={`補評《${r.restaurants?.name ?? '這一餐'}》`}>
                            <StarRow historyId={r.id} onRated={n => onRated(r.id, n)} />
                          </div>
                        ) : (
                          <button type="button" className="chip text-fg-muted"
                            onClick={() => setExpandedId(r.id)}>
                            尚未評分 · 補評
                          </button>
                        )
                      )}
                    </li>
                  ))}
                </ul>
              </section>
            ))}

            {rows.length < total && (
              <p className="text-center text-xs text-fg-muted">僅顯示最近 {rows.length} 筆</p>
            )}
          </>
        )}
      </main>
    </div>
  )
}

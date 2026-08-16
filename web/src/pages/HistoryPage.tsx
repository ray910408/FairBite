import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'
import { formatDay, groupByMonth, knownCuisineLabels, summarize, trendRatings, type FootprintRow } from '../lib/footprint'
import { leaveNotice } from '../lib/leaveNotice'
import type { Room } from '../lib/types'
import { getUid } from '../lib/uid'
import { Logo, Spinner, Star } from '../components/icons'
import StarRow from '../components/StarRow'
import TrendChart from '../components/TrendChart'

// 足跡頁（spec 2026-08-14）：同席紀錄的個人視圖。單一查詢直讀 Supabase
//（RLS 只回自己的列），統計全在前端現算；補評成功只更新本地列，不 refetch。
type LoadState =
  | { phase: 'loading' }
  | { phase: 'error' }
  | { phase: 'ready'; rows: FootprintRow[]; total: number }

// 足跡頁也是「房內可達頁」：回首頁＝離席（ADR-0007），離開前要問
// isHost = null：拿不到 uid，不確定是不是房主（leaveNotice 會退回條件句，不猜）
type LeaveRoom = {
  id: string; code: string; status: Room['status']; memberCount: number; isHost: boolean | null
}
// 查詢失敗時寧可講保守的空話，也不拿過期資料講可能已不成立的後果
type LeaveDialog = { kind: 'rooms'; rooms: LeaveRoom[] } | { kind: 'unknown' }

// 一次查回「我所屬房間」的全部成員列（members_select RLS = is_room_member(room_id)），
// 依 room_id 分組各自算人數——leave 是全退，每個房都要算。null = 查詢失敗（不可判定）。
// host_id 一起帶回來比對 uid：房主退出會移交（leave.go），文案必須講。
async function fetchLeaveRooms(): Promise<LeaveRoom[] | null> {
  try {
    const [{ data, error }, uid] = await Promise.all([
      supabase.from('room_members').select('room_id, rooms(code, status, host_id)'),
      getUid().catch(() => null), // uid 掛掉只讓房主敘述退回條件句，不該連整份後果都放棄
    ])
    if (error) return null
    // rooms 是 to-one 嵌入（room_members.room_id FK），實際回物件；supabase-js 推不出
    // 基數而給成陣列，比照本檔 dining_history 的嵌入走 unknown 轉型
    const rows = (data ?? []) as unknown as
      { room_id: string; rooms: { code: string; status: Room['status']; host_id: string } | null }[]
    const byRoom = new Map<string, LeaveRoom>()
    for (const r of rows) {
      if (!r.rooms) continue
      const hit = byRoom.get(r.room_id)
      if (hit) hit.memberCount++
      else byRoom.set(r.room_id, {
        id: r.room_id, code: r.rooms.code, status: r.rooms.status, memberCount: 1,
        isHost: uid ? r.rooms.host_id === uid : null,
      })
    }
    return [...byRoom.values()]
  } catch {
    return null
  }
}

export default function HistoryPage() {
  const [state, setState] = useState<LoadState>({ phase: 'loading' })
  // 未評列補評 chip 的展開狀態（一次一列，design review D4）
  const [expandedId, setExpandedId] = useState<string | null>(null)
  const [leaveDialog, setLeaveDialog] = useState<LeaveDialog | null>(null)
  const [leaveChecking, setLeaveChecking] = useState(false)
  const expandedLiRef = useRef<HTMLLIElement | null>(null)
  const leaveTriggerRef = useRef<HTMLAnchorElement | null>(null)
  const requestGen = useRef(0)
  // 房籍查詢自己的世代（與 load 分開：兩者互不作廢，否則按一次「重試」就會讓
  // in-flight 的離席查詢靜默消失，使用者按「回首頁」等於沒反應）
  const leaveGen = useRef(0)
  const nav = useNavigate()

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

  // 一律攔下來當場查，不留任何房籍快照：本頁久留是預期用法，而且房籍會在別的分頁被改
  //（多分頁是 ADR-0007 自己承認的情境）。「進頁時沒房」不能拿來放行——那筆快照到點擊
  // 當下可能已經過期，賭錯的代價是靜默退掉別的分頁剛建的房。代價是每次多一次查詢。
  async function askLeave(e: React.MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    leaveTriggerRef.current = e.currentTarget // 兩個入口共用一個 dialog，記住是誰開的
    // 舊回應作廢（load 同款模式）：aria-busy 擋不住點擊，兩次點擊之間房籍還可能在別的
    // 分頁被改。第一次查到「沒房」若晚於第二次回來，就會 nav('/') 跳過剛開好的 dialog，
    // 把新房籍靜默退掉——只有最後一次點擊的回應能生效。
    const request = ++leaveGen.current
    setLeaveChecking(true)
    const rooms = await fetchLeaveRooms()
    if (request !== leaveGen.current) return // 更新的一次在跑，checking 由它負責關掉
    setLeaveChecking(false)
    if (rooms && rooms.length === 0) { // 真的沒房可離：沒有後果可講，照原本的導覽走
      nav('/')
      return
    }
    setLeaveDialog(rooms ? { kind: 'rooms', rooms } : { kind: 'unknown' })
  }

  function closeLeave() {
    setLeaveDialog(null)
    leaveTriggerRef.current?.focus()
  }

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
          {/* 一律攔下當場查（ADR-0007）；查到真的沒房才放行導覽 */}
          <Link to="/" className="btn btn-quiet min-h-11 px-3 text-sm"
            aria-busy={leaveChecking} onClick={askLeave}>回首頁</Link>
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
            <Link to="/" className="btn btn-primary min-h-11 px-4 text-sm"
              aria-busy={leaveChecking} onClick={askLeave}>回首頁開一場</Link>
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
                            onClick={() => {
                              setExpandedId(r.id)
                              // 展開側焦點對稱（final review）：chip 卸載後焦點會落空，
                              // 移進星排第一顆星
                              requestAnimationFrame(() =>
                                expandedLiRef.current?.querySelector<HTMLButtonElement>('button')?.focus())
                            }}>
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

      {leaveDialog && (() => {
        // leave 是全退（POST /api/leave 不挑房），所以每個房籍都要講——舊房 leave 逾時
        // 後又建新房就會同時掛兩個房籍（api.ts 逾時靜默、HomePage 的 finally 照樣解禁）
        const rooms = leaveDialog.kind === 'rooms' ? leaveDialog.rooms : []
        const multi = rooms.length > 1
        return (
          // Esc 掛外層：焦點由 autoFocus 進到「取消」，keydown 從 dialog 內冒泡上來
          <div className="fixed inset-0 z-30 flex items-center justify-center bg-fg/40 p-3"
            onKeyDown={e => { if (e.key === 'Escape') closeLeave() }}>
            {/* 多房籍在矮視窗（320x568）會長到超出畫面，垂直置中則上下一起溢出、
                「取消」構不到：卡片限高在視窗內，只讓中段捲動，標題與按鈕永遠在位 */}
            <div role="dialog" aria-modal="true" aria-labelledby="leave-title"
              className="card flex max-h-full w-full max-w-sm animate-rise flex-col space-y-3">
              <h2 id="leave-title" className="shrink-0 text-base font-semibold">回首頁會離開房間</h2>
              <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">
                {leaveDialog.kind === 'unknown' && (
                  <p className="text-sm text-fg-muted">
                    你還在房間裡，回首頁就會離開。房間現況查不到（連線可能不穩），
                    離開後的影響無法確認——不確定就先取消，稍後再試。
                  </p>
                )}
                {rooms.length === 1 && (
                  <p className="text-sm text-fg-muted">你目前還在房間 {rooms[0].code} 裡：</p>
                )}
                {multi && (
                  <p className="text-sm text-fg-muted">
                    你目前在 {rooms.length} 個房間裡，回首頁會一次全部離開：
                  </p>
                )}
                {rooms.map(r => (
                  <div key={r.id} className={multi ? 'space-y-2 rounded-xl border border-border p-3' : ''}>
                    {multi && <p className="text-sm font-semibold">房間 {r.code}</p>}
                    <ul className="list-disc space-y-1 pl-5 text-sm text-fg-muted">
                      {leaveNotice(r.status, r.memberCount, r.code, r.isHost).map(p => <li key={p}>{p}</li>)}
                    </ul>
                    {multi && (
                      <Link to={`/room/${r.id}`} className="btn btn-quiet w-full">回到 {r.code}</Link>
                    )}
                  </div>
                ))}
              </div>
              {/* 按鈕在 320px 一律直排。「回到房間」補上 ADR-0007 說的不經首頁入口；
                  多房時改掛在各房區塊內，不替使用者猜要回哪一間 */}
              <div className="flex shrink-0 flex-col gap-2">
                {rooms.length === 1 && (
                  <Link to={`/room/${rooms[0].id}`} className="btn btn-primary w-full">回到房間</Link>
                )}
                <button type="button" autoFocus className="btn btn-quiet w-full" onClick={closeLeave}>
                  取消
                </button>
                <Link to="/" className="btn w-full bg-danger text-white">仍要回首頁</Link>
              </div>
            </div>
          </div>
        )
      })()}
    </div>
  )
}

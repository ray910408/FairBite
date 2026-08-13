import { useEffect, useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useRoom } from '../hooks/useRoom'
import { startVoting } from '../lib/api'
import { isVetoDeadEnd } from '../lib/deadEnd'
import { EXPLORATION_OPTIONS } from '../lib/labels'
import { buildMealTimeISO, formatMealTime } from '../lib/mealTime'
import { isGoogleSourced } from '../lib/placesSource'
import { supabase } from '../lib/supabase'
import type { Room } from '../lib/types'
import ConditionsForm from '../components/ConditionsForm'
import CandidateList from '../components/CandidateList'
import Wheel from '../components/Wheel'
import ResultCard from '../components/ResultCard'
import RatingPrompt from '../components/RatingPrompt'
import { Alert, Check, Copy, Logo, Spinner, Users } from '../components/icons'

const STEPS = [
  { key: 'lobby', label: '設定條件' },
  { key: 'candidates', label: '候選出爐' },
  { key: 'voting', label: '投票' },
  { key: 'decided', label: '定案' },
] as const

function Stepper({ status }: { status: Room['status'] }) {
  const current = STEPS.findIndex(s => s.key === status)
  return (
    <ol className="flex items-center gap-1 text-xs">
      {STEPS.map((s, i) => (
        <li key={s.key} className="flex flex-1 items-center gap-1">
          <span className={`flex h-6 w-6 shrink-0 items-center justify-center rounded-full font-semibold ${
            i < current ? 'bg-ok text-white'
              : i === current ? 'bg-brand text-white'
              : 'bg-brand-soft text-brand-strong/60'
          }`}>
            {i < current ? <Check className="h-3.5 w-3.5" /> : i + 1}
          </span>
          <span className={i === current ? 'font-semibold text-fg' : 'text-fg-muted'}>{s.label}</span>
          {i < STEPS.length - 1 && <span className="h-px flex-1 bg-border" />}
        </li>
      ))}
    </ol>
  )
}

export default function RoomPage() {
  const { id = '' } = useParams()
  const { room, members, candidates, draw, myUserId, connected, notFound,
    toggleVote, myVote, ups, vetoesRemaining } = useRoom(id)
  const [spun, setSpun] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionWarning, setActionWarning] = useState('')
  const [copied, setCopied] = useState(false)
  const [editingCustom, setEditingCustom] = useState(false)
  const [draftHH, setDraftHH] = useState('')
  const [draftMM, setDraftMM] = useState('')
  const mealTimeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const searchInFlight = useRef(false)
  const startVotingInFlight = useRef(false)
  useEffect(() => {
    const d = room?.meal_time ? new Date(room.meal_time) : null
    setDraftHH(d ? String(d.getHours()).padStart(2, '0') : '')
    setDraftMM(d ? String(d.getMinutes()).padStart(2, '0') : '')
  }, [room?.meal_time])
  if (!room) return notFound ? (
    <main className="mx-auto flex min-h-screen max-w-sm flex-col items-center justify-center gap-4 p-6 text-center">
      <Logo className="h-12 w-12 opacity-60" />
      <p className="text-fg-muted">找不到房間，或你不是成員</p>
      <Link to="/" className="btn btn-primary px-6">回首頁</Link>
    </main>
  ) : (
    <div className="flex min-h-screen flex-col items-center justify-center gap-3 text-fg-muted">
      <Spinner className="h-7 w-7 text-brand" />
      <p className="text-sm">讀取房間…</p>
    </div>
  )

  const me = members.find(m => m.user_id === myUserId)
  const isHost = room.host_id === myUserId
  function saveMealTime(iso: string | null) {
    setActionError('')
    clearTimeout(mealTimeTimer.current)
    mealTimeTimer.current = setTimeout(async () => {
      const { error, count } = await supabase.from('rooms')
        .update({ meal_time: iso }, { count: 'exact' }).eq('id', room!.id)
      if (error || count === 0) {
        const d = room?.meal_time ? new Date(room.meal_time) : null
        setDraftHH(d ? String(d.getHours()).padStart(2, '0') : '')
        setDraftMM(d ? String(d.getMinutes()).padStart(2, '0') : '')
        setActionError('用餐時間更新失敗')
      } else if (iso === null) {
        setEditingCustom(false)
        setDraftHH('')
        setDraftMM('')
      }
    }, 400)
  }

  function updateMealTime(hhmm: string) {
    setActionError('')
    const r = buildMealTimeISO(hhmm)
    if ('error' in r) { setActionError(r.error); return }
    saveMealTime(r.iso)
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room!.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setActionError('複製失敗，請手動記下邀請碼')
    }
  }

  // 投票規則（op 判定/連點鎖/本地鏡射）都在 useRoom；這裡只負責把錯誤接到畫面
  async function onToggleVote(restaurantId: string, kind: 'up' | 'veto') {
    setActionError('')
    const msg = await toggleVote(restaurantId, kind)
    if (msg) setActionError(msg) // D4：伺服器訊息直達（額度用盡/不在投票階段都有明確下一步）
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-20 border-b border-border bg-canvas/85 backdrop-blur">
        <div className="mx-auto flex w-full max-w-lg items-center gap-3 p-3">
          <Link to="/" aria-label="回首頁"
            className="-ml-1.5 flex h-11 w-11 shrink-0 items-center justify-center rounded-xl">
            <Logo className="h-8 w-8" />
          </Link>
          {/* 12 碼在 320px 塞不下 text-lg + 0.25em 字距，小螢幕縮小、sm 以上維持原樣 */}
          <button onClick={copyCode}
            className="btn btn-quiet min-h-11 gap-2 px-2 font-mono text-sm sm:px-3 sm:text-lg sm:tracking-[0.25em]">
            {room.code}
            {copied ? <Check className="h-4 w-4 text-ok" /> : <Copy className="h-4 w-4 text-fg-muted" />}
          </button>
          <span className="sr-only" aria-live="polite">{copied ? '邀請碼已複製' : ''}</span>
          <span className="ml-auto whitespace-nowrap rounded-full bg-brand-soft px-3 py-1 text-xs font-semibold text-brand-strong">
            {{ lobby: '等待中', candidates: '候選已出爐', voting: '投票中', decided: '已定案' }[room.status]}
          </span>
        </div>
        <div className="mx-auto w-full max-w-lg px-3 pb-3">
          <Stepper status={room.status} />
        </div>
      </header>

      <main className="mx-auto w-full max-w-lg space-y-4 p-4">
        {!connected && (
          <p role="status" className="banner bg-warn-soft text-warn">
            <Alert className="h-5 w-5 shrink-0" />
            <span>連線中斷，嘗試重連中… 畫面可能不是最新狀態</span>
          </p>
        )}

        {actionError && (
          <p role="alert" className="banner bg-danger-soft whitespace-pre-line text-danger">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{actionError}</span>
          </p>
        )}
        {actionWarning && (
          <p role="status" className="banner bg-warn-soft text-warn">
            <Alert className="h-5 w-5 shrink-0" />
            <span>{actionWarning}</span>
          </p>
        )}

        <section className="card animate-rise">
          <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg-muted">
            <Users className="h-4 w-4" />
            成員（{members.length}）
          </h2>
          <ul className="space-y-2">
            {members.map(m => (
              <li key={m.user_id} className="flex items-center gap-2 text-sm">
                <span aria-hidden="true"
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-brand-soft text-xs font-semibold text-brand-strong">
                  {(m.profiles?.display_name ?? '成').slice(0, 2)}
                </span>
                <span className="flex-1 truncate">
                  {m.profiles?.display_name ?? '成員'}
                  {m.user_id === room.host_id && (
                    <span className="ml-1 text-xs text-fg-muted">（房主）</span>
                  )}
                </span>
                <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-medium ${
                  m.ready ? 'bg-ok-soft text-ok' : 'bg-brand-soft/60 text-fg-muted'
                }`}>
                  {m.ready && <Check className="h-3.5 w-3.5" />}
                  {m.ready ? '已準備' : '設定中'}
                </span>
              </li>
            ))}
          </ul>
        </section>

        {(room.status === 'candidates' || room.status === 'voting') && (
          <p className="text-xs text-fg-muted">
            探索檔位：{EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[1]}
            ・用餐時間：{formatMealTime(room.meal_time)}
          </p>
        )}
        {room.status === 'lobby' && (
          <section className="card animate-rise">
            <h2 className="mb-1 text-sm font-semibold text-fg-muted">探索檔位</h2>
            <p className="mb-3 text-xs text-fg-muted">
              {EXPLORATION_OPTIONS.find(([k]) => k === room.exploration)?.[2]}
              {!isHost && '（由房主設定）'}
            </p>
            {/* D14：冷啟動誠實說明 —— 檔位靠同席紀錄運作，沒紀錄前三檔等效 */}
            <p className="mb-3 text-xs text-fg-muted">
              檔位依成員的同席紀錄調整機率；大家開始用這裡抽餐廳後才會逐漸生效
            </p>
            <div className="grid grid-cols-3 gap-1 rounded-xl bg-brand-soft p-1">
              {EXPLORATION_OPTIONS.map(([key, label]) => (
                <button key={key} type="button" aria-pressed={room.exploration === key}
                  disabled={!isHost}
                  className={`min-h-10 rounded-lg text-sm font-semibold transition-colors duration-150 ${
                    room.exploration === key ? 'bg-surface text-brand shadow-sm' : 'text-brand-strong'
                  } disabled:cursor-default`}
                  onClick={async () => {
                    setActionError('')
                    // count:'exact'：RLS 擋下時 204 無 error，只看 error 會誤判成功
                    const { error, count } = await supabase.from('rooms')
                      .update({ exploration: key }, { count: 'exact' }).eq('id', room.id)
                    if (error || count === 0) setActionError('探索檔位更新失敗')
                  }}>
                  {label}
                </button>
              ))}
            </div>
          </section>
        )}
        {room.status === 'lobby' && (
          <section className="card animate-rise">
            <h2 className="mb-1 text-sm font-semibold text-fg-muted">用餐時間</h2>
            <p className="mb-3 text-xs text-fg-muted">
              {formatMealTime(room.meal_time)}
              {!isHost && '（由房主設定）'}
            </p>
            {isHost && (
              <div className="space-y-2">
                <div className="grid grid-cols-2 gap-1 rounded-xl bg-brand-soft p-1">
                  <button type="button" aria-pressed={room.meal_time === null && !editingCustom}
                    className={`min-h-10 rounded-lg text-sm font-semibold transition-colors duration-150 ${
                      room.meal_time === null && !editingCustom
                        ? 'bg-surface text-brand shadow-sm' : 'text-brand-strong'
                    }`}
                    onClick={() => saveMealTime(null)}>
                    馬上出發
                  </button>
                  <button type="button" aria-pressed={room.meal_time !== null || editingCustom}
                    className={`min-h-10 rounded-lg text-sm font-semibold transition-colors duration-150 ${
                      room.meal_time !== null || editingCustom
                        ? 'bg-surface text-brand shadow-sm' : 'text-brand-strong'
                    }`}
                    onClick={() => setEditingCustom(true)}>
                    自訂時間
                  </button>
                </div>
                {(editingCustom || room.meal_time !== null) && (
                  <div className="flex items-center gap-2">
                    <select className="field flex-1" aria-label="用餐時間（時）"
                      value={draftHH}
                      onChange={e => {
                        const hh = e.target.value
                        setDraftHH(hh)
                        if (hh && draftMM) void updateMealTime(`${hh}:${draftMM}`)
                      }}>
                      <option value="" disabled>時</option>
                      {Array.from({ length: 24 }, (_, h) => String(h).padStart(2, '0')).map(h => (
                        <option key={h} value={h}>{h}</option>
                      ))}
                    </select>
                    <span className="text-fg-muted">:</span>
                    <select className="field flex-1" aria-label="用餐時間（分）"
                      value={draftMM}
                      onChange={e => {
                        const mm = e.target.value
                        setDraftMM(mm)
                        if (draftHH && mm) void updateMealTime(`${draftHH}:${mm}`)
                      }}>
                      <option value="" disabled>分</option>
                      {Array.from({ length: 12 }, (_, i) => String(i * 5).padStart(2, '0')).map(m => (
                        <option key={m} value={m}>{m}</option>
                      ))}
                    </select>
                  </div>
                )}
              </div>
            )}
          </section>
        )}
        {room.status === 'lobby' && me && <ConditionsForm me={me} />}
        {room.status === 'lobby' && isHost && (
          <button className="btn btn-primary w-full"
            onClick={() => {
              const notReady = members.filter(m => !m.ready).length
              if (notReady > 0 &&
                !confirm(`還有 ${notReady} 位成員未按準備，開始後條件將凍結。確定開始搜尋？`)) return
              if (searchInFlight.current) return
              searchInFlight.current = true
              setActionError('')
              import('../lib/api').then(m => m.searchRoom(room.id))
                .then(o => { setActionError(o.error ?? ''); setActionWarning(o.warning ?? '') })
                .catch(() => setActionError('搜尋失敗：無法連線到伺服器'))
                .finally(() => { searchInFlight.current = false })
            }}>
            開始搜尋餐廳
          </button>
        )}
        {room.status === 'candidates' && (
          <>
            <CandidateList rows={candidates} />
            {isHost && (
              <button className="btn btn-primary w-full"
                onClick={async () => {
                  if (startVotingInFlight.current) return
                  startVotingInFlight.current = true
                  setActionError('')
                  const msg = await startVoting(room.id)
                    .catch(() => '開始投票失敗：無法連線到伺服器')
                  startVotingInFlight.current = false
                  if (msg) setActionError(msg)
                }}>
                開始投票
              </button>
            )}
          </>
        )}
        {room.status === 'voting' && (
          <>
            <CandidateList rows={candidates}
              voting={{ myVote, ups, vetoesRemaining, onToggle: onToggleVote }} />
            {candidates.some(c => c.status === 'kept') ? null : (
              // D16：「全否決」和「全打烊」是兩種死路——用結構化 exclusion_kinds 分辨（deadEnd.ts）
              <p role="status" className="banner bg-warn-soft text-warn">
                <Alert className="h-5 w-5 shrink-0" />
                <span>{isVetoDeadEnd(candidates)
                  ? '候選已全數被否決，需有人收回否決才能抽選'
                  : '候選已全數失效（可能都打烊了），請建立新房間重新搜尋'}</span>
              </p>
            )}
            {isHost && (
              <button className="btn btn-primary w-full"
                disabled={!candidates.some(c => c.status === 'kept')}
                onClick={() => {
                  setActionError('')
                  import('../lib/api').then(m => m.drawRoom(room.id))
                    .then(msg => setActionError(msg ?? ''))
                    .catch(() => setActionError('抽選失敗：無法連線到伺服器'))
                }}>
                啟動轉盤
              </button>
            )}
          </>
        )}
        {room.status === 'decided' && draw && (
          <div className="space-y-4">
            {!spun ? (
              <Wheel rows={candidates} winnerId={draw.winner_restaurant_id}
                onDone={() => setSpun(true)} />
            ) : (
              <>
                <ResultCard draw={draw} candidates={candidates} me={me} />
                <RatingPrompt roomId={room.id} />
              </>
            )}
            {candidates.some(c => c.status === 'kept' && isGoogleSourced(c.restaurants.source)) && (
              <p className="text-xs text-fg-muted">餐廳資料 Powered by Google</p>
            )}
            <p className="text-xs text-fg-muted">天氣資料 Open-Meteo.com（CC BY 4.0）</p>
          </div>
        )}
      </main>
    </div>
  )
}

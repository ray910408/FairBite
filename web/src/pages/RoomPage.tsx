import { useRef, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useRoom } from '../hooks/useRoom'
import { startVoting, voteRoom } from '../lib/api'
import { EXPLORATION_OPTIONS } from '../lib/labels'
import { supabase } from '../lib/supabase'
import type { Room } from '../lib/types'
import ConditionsForm from '../components/ConditionsForm'
import CandidateList from '../components/CandidateList'
import Wheel from '../components/Wheel'
import ResultCard from '../components/ResultCard'
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
  const { room, members, candidates, draw, votes, setVotes, myUserId, connected, notFound } = useRoom(id)
  const [spun, setSpun] = useState(false)
  const [actionError, setActionError] = useState('')
  const [actionWarning, setActionWarning] = useState('')
  const [copied, setCopied] = useState(false)
  const voteInFlight = useRef(false)
  const searchInFlight = useRef(false)
  const startVotingInFlight = useRef(false)
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

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(room!.code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch {
      setActionError('複製失敗，請手動記下邀請碼')
    }
  }

  async function toggleVote(restaurantId: string, kind: 'up' | 'veto') {
    if (voteInFlight.current) return // D6：連點鎖 —— 慢網路下不重送、不閃假錯誤
    voteInFlight.current = true
    setActionError('')
    const has = votes.some(v =>
      v.user_id === myUserId && v.restaurant_id === restaurantId && v.kind === kind)
    const op = has ? 'retract' : 'cast'
    const msg = await voteRoom(room!.id, restaurantId, kind, op)
      .catch(() => '投票失敗：無法連線到伺服器')
    voteInFlight.current = false
    if (msg) {
      setActionError(msg) // D4：伺服器訊息直達（額度用盡/不在投票階段都有明確下一步）
      return
    }
    // D6：本地先行 merge —— 按鈕 aria-pressed 立即反應，不等 Realtime round-trip；
    // cast 同時清掉自己同店另一 kind（鏡射伺服器互斥語意），權威資料稍後由 refetch 帶回
    setVotes(vs => op === 'retract'
      ? vs.filter(v => !(v.user_id === myUserId && v.restaurant_id === restaurantId && v.kind === kind))
      : [...vs.filter(v => !(v.user_id === myUserId && v.restaurant_id === restaurantId)),
          { room_id: room!.id, user_id: myUserId, restaurant_id: restaurantId, kind }])
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
              voting={{ votes, myUserId, onToggle: toggleVote }} />
            {candidates.some(c => c.status === 'kept') ? null : (
              // D16：「全否決」和「全打烊」是兩種死路——理由字串是自家 contract，可安全判斷
              <p role="status" className="banner bg-warn-soft text-warn">
                <Alert className="h-5 w-5 shrink-0" />
                <span>{candidates.some(c => c.exclusion_reason?.includes('否決'))
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
          !spun ? (
            <Wheel rows={candidates} winnerId={draw.winner_restaurant_id}
              onDone={() => setSpun(true)} />
          ) : (
            <ResultCard draw={draw} candidates={candidates} me={me} />
          )
        )}
      </main>
    </div>
  )
}

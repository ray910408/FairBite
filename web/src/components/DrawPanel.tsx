import { Link } from 'react-router-dom'
import { isGoogleSourced } from '../lib/placesSource'
import { snapshotCandidates } from '../lib/probability'
import type { CandidateRow, DrawRow, MemberRow, Room } from '../lib/types'
import { markWheelSeen, wheelSeen } from '../lib/wheelSeen'
import { GuestRegistrationPrompt } from './GuestRegistrationPrompt'
import RatingPrompt from './RatingPrompt'
import ResultCard from './ResultCard'
import Wheel from './Wheel'
import { Spinner } from './icons'

// 抽中待確認／定案：先轉盤，轉完換結果卡；待確認時房主可確認或排除這家重轉。
// 這次抽選在這台裝置看過就不重播（wheelSeen）
export default function DrawPanel({ room, draw, candidates, spun, onSpun, me, myUserId, isHost, isGuest,
  pendingAction, lastCandidate, onRedraw, onConfirm, onFinish, finishing }: {
  room: Room
  draw: DrawRow
  candidates: CandidateRow[]
  spun: boolean
  onSpun: () => void
  me: MemberRow | undefined
  myUserId: string
  isHost: boolean
  isGuest: boolean
  pendingAction: 'draw' | 'confirm' | 'redraw' | null
  // 只剩抽中的這一家：重轉會排光候選、全房回準備階段，按鈕要直說
  lastCandidate: boolean
  onRedraw: (e: React.MouseEvent<HTMLButtonElement>) => void
  onConfirm: () => void
  // 定案後「完成，回到首頁」：走房內同一套離席流程（只剩這間定案房時不開框）
  onFinish: (e: React.MouseEvent<HTMLAnchorElement>) => void
  finishing: boolean
}) {
  const drawCandidates = snapshotCandidates(candidates, draw.probabilities)
  return (
    <div className="space-y-4">
      {!spun && !wheelSeen(room.id, draw.version) && draw.probabilities[draw.winner_restaurant_id] != null ? (
        <Wheel key={draw.version} rows={drawCandidates} winnerId={draw.winner_restaurant_id}
          onDone={() => { markWheelSeen(room.id, draw.version); onSpun() }} />
      ) : (
        <>
          <ResultCard draw={draw} candidates={drawCandidates} me={me}
            confirmed={room.status === 'decided'} />
          {room.status === 'decided' && <RatingPrompt roomId={room.id} />}
          {room.status === 'decided' && isGuest && (
            <GuestRegistrationPrompt userId={myUserId} roomId={room.id} open />
          )}
          {/* 定案後沒有下一步：給一顆看得見的出口，不必去找左上角的 logo。
              文字別含「回首頁」：那是 logo 的 aria-label，子字串比對的選取器（Playwright）會抓到兩個 */}
          {room.status === 'decided' && (
            <Link to="/" onClick={onFinish} aria-busy={finishing} className="btn btn-quiet w-full">
              {finishing ? <><Spinner className="h-5 w-5" />處理中…</> : '完成，回到首頁'}
            </Link>
          )}
          {room.status === 'pending' && isHost && (
            <div className="grid grid-cols-2 gap-3">
              <button type="button" className="btn btn-secondary w-full"
                disabled={pendingAction !== null} aria-busy={pendingAction === 'redraw'}
                onClick={onRedraw}>
                {pendingAction === 'redraw' ? <><Spinner className="h-5 w-5" />重轉中…</>
                  : lastCandidate ? '排除並回到準備階段' : '排除這家並重轉'}
              </button>
              <button type="button" className="btn btn-primary w-full"
                disabled={pendingAction !== null} aria-busy={pendingAction === 'confirm'}
                onClick={onConfirm}>
                {pendingAction === 'confirm' ? <><Spinner className="h-5 w-5" />確認中…</> : '確認就吃這家'}
              </button>
            </div>
          )}
        </>
      )}
      {candidates.some(c => c.status === 'kept' && isGoogleSourced(c.restaurants.source)) && (
        <p className="text-xs text-fg-muted">餐廳資料 Powered by Google</p>
      )}
      <p className="text-xs text-fg-muted">天氣資料 Open-Meteo.com（CC BY 4.0）</p>
    </div>
  )
}

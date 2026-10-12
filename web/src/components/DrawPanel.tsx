import { isGoogleSourced } from '../lib/placesSource'
import { snapshotCandidates } from '../lib/probability'
import type { CandidateRow, DrawRow, MemberRow, Room } from '../lib/types'
import { GuestRegistrationPrompt } from './GuestRegistrationPrompt'
import RatingPrompt from './RatingPrompt'
import ResultCard from './ResultCard'
import Wheel from './Wheel'
import { Spinner } from './icons'

// 抽中待確認／定案：先轉盤，轉完換結果卡；待確認時房主可確認或排除這家重轉
export default function DrawPanel({ room, draw, candidates, spun, onSpun, me, myUserId, isHost, isGuest,
  pendingAction, onRedraw, onConfirm }: {
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
  onRedraw: () => void
  onConfirm: () => void
}) {
  const drawCandidates = snapshotCandidates(candidates, draw.probabilities)
  return (
    <div className="space-y-4">
      {!spun && draw.probabilities[draw.winner_restaurant_id] != null ? (
        <Wheel key={draw.version} rows={drawCandidates} winnerId={draw.winner_restaurant_id}
          onDone={onSpun} />
      ) : (
        <>
          <ResultCard draw={draw} candidates={drawCandidates} me={me}
            confirmed={room.status === 'decided'} />
          {room.status === 'decided' && <RatingPrompt roomId={room.id} />}
          {room.status === 'decided' && isGuest && (
            <GuestRegistrationPrompt userId={myUserId} roomId={room.id} open />
          )}
          {room.status === 'pending' && isHost && (
            <div className="grid grid-cols-2 gap-3">
              <button type="button" className="btn btn-secondary w-full"
                disabled={pendingAction !== null} aria-busy={pendingAction === 'redraw'}
                onClick={onRedraw}>
                {pendingAction === 'redraw' ? <><Spinner className="h-5 w-5" />重轉中…</> : '排除這家並重轉'}
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

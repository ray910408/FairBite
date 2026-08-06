import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useRoom } from '../hooks/useRoom'
import ConditionsForm from '../components/ConditionsForm'
import CandidateList from '../components/CandidateList'
import Wheel from '../components/Wheel'
import ResultCard from '../components/ResultCard'

export default function RoomPage() {
  const { id = '' } = useParams()
  const { room, members, candidates, draw, myUserId, connected, notFound } = useRoom(id)
  const [spun, setSpun] = useState(false)
  const [actionError, setActionError] = useState('')
  if (!room) return notFound ? (
    <div className="space-y-3 p-8 text-center">
      <p>找不到房間，或你不是成員</p>
      <Link to="/" className="text-orange-600 underline">回首頁</Link>
    </div>
  ) : <p className="p-8 text-center">載入中…</p>

  const me = members.find(m => m.user_id === myUserId)
  const isHost = room.host_id === myUserId

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      {!connected && (
        <div className="rounded bg-amber-100 p-2 text-center text-sm text-amber-800">
          連線中斷，嘗試重連中… 畫面可能不是最新狀態
        </div>
      )}
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">房間 {room.code}</h1>
        <span className="text-sm text-gray-500">{
          { lobby: '等待中', candidates: '候選已出爐', decided: '已定案' }[room.status]
        }</span>
      </header>

      {actionError && (
        <div className="whitespace-pre-line rounded bg-red-100 p-2 text-center text-sm text-red-800">
          {actionError}
        </div>
      )}

      <section className="rounded border p-3">
        <h2 className="mb-2 text-sm text-gray-600">成員（{members.length}）</h2>
        <ul className="space-y-1">
          {members.map(m => (
            <li key={m.user_id} className="flex justify-between text-sm">
              <span>
                {m.profiles?.display_name ?? '成員'}
                {m.user_id === room.host_id && '（房主）'}
              </span>
              <span className={m.ready ? 'text-green-600' : 'text-gray-400'}>
                {m.ready ? '已準備' : '設定中'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {room.status === 'lobby' && me && <ConditionsForm me={me} />}
      {room.status === 'lobby' && isHost && (
        <button className="w-full rounded bg-orange-500 p-3 text-white"
          onClick={() => {
            const notReady = members.filter(m => !m.ready).length
            if (notReady > 0 &&
              !confirm(`還有 ${notReady} 位成員未按準備，開始後條件將凍結。確定開始搜尋？`)) return
            setActionError('')
            import('../lib/api').then(m => m.searchRoom(room.id))
              .then(msg => setActionError(msg ?? ''))
              .catch(() => setActionError('搜尋失敗：無法連線到伺服器'))
          }}>
          開始搜尋餐廳
        </button>
      )}
      {room.status === 'candidates' && (
        <>
          <CandidateList rows={candidates} />
          {isHost && (
            <button className="w-full rounded bg-orange-500 p-3 text-white"
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
    </div>
  )
}

import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { leaveNotice } from '../lib/leaveNotice'
import type { LeaveTarget } from '../lib/roomMembership'

// 「回首頁＝離席」（ADR-0007）確認框的共用外殼，三個呼叫端共用：RoomPage 的 header
// logo、HistoryPage 的兩個回首頁入口、HomePage 的 mount 攔截。
//
// 這段版面不是裝飾：多房籍在 320x568 會長到超出畫面，垂直置中時上下一起溢出、
// 「取消」與「確認」都點不到。卡片限高在視窗內（max-h-full + flex-col），只讓中段
// 捲動（min-h-0 flex-1 overflow-y-auto——沒有 min-h-0 這個 flex item 不肯縮），
// 標題與按鈕組 shrink-0 永遠在位。實機量測驗過，第三次手抄必走鐘，故抽出。
//
// 按鈕組由呼叫端帶入：三處的鈕數、順序與 320px 排法都不同（RoomPage 在 sm 以上並排，
// 另兩處一律直排）。autoFocus 與關閉後的焦點還原也留在呼叫端——觸發元素只有呼叫端
// 知道，HomePage 的 mount 攔截根本沒有觸發元素。
//
// 以函式呼叫（LeaveConfirm({...})）而非 <LeaveConfirm />：本外殼沒有自己的狀態，
// 直接回傳元素樹，三頁的測試（把 page 當純函式呼叫）看到的結構才不變。
export function LeaveConfirm({ title, onClose, actions, actionsClassName, children }: {
  title: string
  // Esc 關閉；HomePage 的 mount 攔截沒有「留在首頁但不決定」的合法終態，故不給
  onClose?: () => void
  actions: ReactNode
  actionsClassName?: string
  children: ReactNode
}) {
  return (
    // Esc 掛外層：焦點由 autoFocus 進到按鈕，keydown 從 dialog 內冒泡上來
    <div className="fixed inset-0 z-30 flex items-center justify-center bg-fg/40 p-3"
      onKeyDown={onClose && (e => { if (e.key === 'Escape') onClose() })}>
      <div role="dialog" aria-modal="true" aria-labelledby="leave-title"
        className="card flex max-h-full w-full max-w-sm animate-rise flex-col space-y-3">
        <h2 id="leave-title" className="shrink-0 text-base font-semibold">{title}</h2>
        <div className="min-h-0 flex-1 space-y-3 overflow-y-auto">{children}</div>
        <div className={`flex shrink-0 flex-col gap-2 ${actionsClassName ?? ''}`}>{actions}</div>
      </div>
    </div>
  )
}

// 房內可達頁（RoomPage / HistoryPage）的後果內文：兩處字句完全相同，且 `POST /api/leave`
// 是全退不挑房——只講「當前這一間」會漏報殘留房籍（P2-A 在足跡頁修過的同一個洞）。
// 資料一律來自點擊當下的 fetchLeaveRooms()，不讀任何本地快照：useRoom 的 room 在查詢
// 失敗時會保留舊物件（useRoom.ts:46 只在 r.data 為真時 setRoom），拿它的 status 講
// 「之後可用邀請碼重新加入」時 join_room 可能早就不匹配了。
//
// HomePage 的 mount 攔截不共用這段：它已經在首頁（時態不同），而且回房入口必須是
// <button>——React 的 autoFocus 只對表單控制項生效，焦點要落在安全那顆。
export function LeaveRoomsBody({ target }: { target: LeaveTarget }) {
  const rooms = target.kind === 'rooms' ? target.rooms : []
  const multi = rooms.length > 1
  return (
    <>
      {target.kind === 'unknown' && (
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
    </>
  )
}

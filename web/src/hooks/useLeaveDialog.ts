import { useRef, useState, type MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { pendingLeave } from '../lib/api'
import { fetchLeaveRooms, type LeaveTarget } from '../lib/roomMembership'

// 「回首頁＝離席」（ADR-0007）的確認流程，房內可達頁（RoomPage、HistoryPage）共用：回首頁的連結
// 一律攔下來當場查房籍，查到房才開確認框；關框後焦點回到開框的那個入口。
//
// 一律當場查，不讀頁面任何本地狀態、不留房籍快照：
// 1. 房籍會在別的分頁被改（多分頁是 ADR-0007 自己承認的情境），足跡頁久留又是預期用法：
//    「進頁時沒房」到點擊當下可能已經過期，拿它放行，賭錯的代價是靜默退掉別的分頁剛建的房。
// 2. useRoom 的 room 在 rooms 查詢失敗時會停在舊物件（useRoom 的 refetch 只在查到列時更新 room、
//    查無列才清成 null，暫時性錯誤只亮 loadError）——lobby→candidates 期間 refresh 失敗或 Realtime
//    斷線，拿過期 status 就會承諾「之後可用邀請碼重新加入」，而 join_room 早就不匹配。
// 3. POST /api/leave 是全退不挑房，殘留房籍（leave 逾時後又建新房）也會一起退掉，
//    只講當前這一間就是漏報。
// 代價是每次多一次查詢與非同步開啟（aria-busy 回饋）；不可逆動作上正確性優先於即時感。
//
// onOpen：開框前呼叫。RoomPage 用它關掉查房籍期間先開的站內確認框（那時背景還沒 inert），
// 兩個 dialog 不能疊在一起
export function useLeaveDialog({ onOpen }: { onOpen?: () => void } = {}) {
  const nav = useNavigate()
  const [leaveDialog, setLeaveDialog] = useState<LeaveTarget | null>(null)
  const [leaveChecking, setLeaveChecking] = useState(false)
  // 開框的入口，關框後焦點還給它：點擊時當場記下（足跡頁有兩個入口共用一個 dialog），只在關框時讀
  const leaveTriggerRef = useRef<HTMLAnchorElement | null>(null)
  // 房籍查詢自己的世代：aria-busy 擋不住點擊，兩次點擊之間房籍還可能在別的分頁被改。
  // 第一次查到「沒房」若晚於第二次回來，就會 nav('/') 跳過剛開好的 dialog，把新房籍靜默退掉——
  // 只有最後一次點擊的回應能生效。直接回首頁的那一下也算一次，較早還在查的回應就不會再導航第二次。
  // 與頁面自己的載入世代（足跡頁的 load）分開：兩者互不作廢，否則按一次「重試」就會讓
  // in-flight 的離席查詢靜默消失，使用者按「回首頁」等於沒反應
  const leaveGen = useRef(0)

  async function askLeave(e: MouseEvent<HTMLAnchorElement>) {
    e.preventDefault()
    leaveTriggerRef.current = e.currentTarget
    const request = ++leaveGen.current
    // 首頁的退房還在飛（上一頁回到房內、或冷啟動時點進足跡再回首頁）：這裡等它落地，按鈕會無聲
    // 卡到 50 秒。直接回首頁，由首頁 mount 等（fetchLeaveRooms），等待中的狀態列看得見
    if (pendingLeave()) {
      nav('/')
      return
    }
    setLeaveChecking(true)
    const rooms = await fetchLeaveRooms()
    if (request !== leaveGen.current) return // 更新的一次在跑，checking 由它負責關掉
    setLeaveChecking(false)
    if (rooms && rooms.length === 0) { // 房籍已消失（被踢／房已刪）：沒有後果可講，照原本的導覽走
      nav('/')
      return
    }
    onOpen?.()
    setLeaveDialog(rooms ? { kind: 'rooms', rooms } : { kind: 'unknown' })
  }

  function closeLeave() {
    setLeaveDialog(null)
    // 觸發元素不隨 dialog 卸載，但背景整塊帶著 inert：setLeaveDialog 不同步 flush，
    // 同一輪呼叫 focus() 時觸發元素仍在 inert 子樹內，瀏覽器直接忽略、焦點掉回 body。
    // 排到移除 inert 的那次 commit 之後才還原（比照足跡頁 onRated 的同款 rAF）。
    requestAnimationFrame(() => leaveTriggerRef.current?.focus())
  }

  return { leaveDialog, leaveChecking, askLeave, closeLeave }
}

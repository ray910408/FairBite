import type { Room } from './types'

// 「回首頁＝離席」（ADR-0007）的後果清單，RoomPage 與 HistoryPage 共用一份——
// 這段文案的準確度出過 bug，複製第二份必走鐘。
//
// 兩個事實決定分歧：
// 1. 末位退房的 delete from rooms 不看 status（server/leave.go）——單人房「會被刪除」
//    是確定事件，邀請碼一定跟著失效，不能承諾之後可重加入。
// 2. join_room 只匹配 status = 'lobby'（migration 0003/0006）——lobby 之後一律不可重加入。
export function leaveNotice(
  status: Room['status'], memberCount: number, code: string,
): string[] {
  const solo = memberCount <= 1
  const deletePoint = solo
    ? '你是房間裡唯一的人，離開後這個房間會直接刪除'
    : '你若是最後一位成員，房間會直接被刪除'
  if (status === 'lobby') {
    return solo
      ? [deletePoint,
        `邀請碼 ${code} 會跟著失效，要再約只能重開一場`,
        '你設定的條件也會一起消失']
      : ['你設定的條件會作廢，不再影響這場決策',
        deletePoint,
        '目前還在等待中，之後可用邀請碼重新加入；房主一開始搜尋就不能再加入']
  }
  if (status === 'decided') {
    return ['你的投票會作廢',
      deletePoint,
      '房間已經開始，離開後無法用邀請碼重新加入，只能另開新房',
      '房間已定案，抽中的結果之後只能在「足跡」查看']
  }
  // candidates 階段還沒有票（贊成／否決鈕只在 voting 出現，RoomPage 的 CandidateList
  // 只有 voting 才拿到 voting prop）；離席在這裡是條件退出重算（ADR-0007、leave.go 的 rescore）
  if (status === 'candidates') {
    return ['你的條件與偏好會退出重算，候選名單會重新分割',
      deletePoint,
      '房間已經開始，離開後無法用邀請碼重新加入，只能另開新房']
  }
  return ['你的投票會即刻作廢，候選盤面會重新計算',
    deletePoint,
    '房間已經開始，離開後無法用邀請碼重新加入，只能另開新房']
}

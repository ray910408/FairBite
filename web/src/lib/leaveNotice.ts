import type { Room } from './types'

// 「回首頁＝離席」（ADR-0007）的後果清單，RoomPage 與 HistoryPage 共用一份——
// 這段文案的準確度出過 bug，複製第二份必走鐘。
//
// 三個事實決定分歧：
// 1. 末位退房的 delete from rooms 不看 status（server/leave.go）——單人房「會被刪除」
//    是確定事件，邀請碼一定跟著失效，不能承諾之後可重加入。而且刪房那條路徑 delete 完
//    直接 return，走不到後面的 rescoreRoom：單人房沒有盤面可以重算，不得承諾「重新
//    分割／重新計算」——那句跟同一張 dialog 上的「房間會直接刪除」直接打架。
// 2. join_room 只匹配 status = 'lobby'（migration 0003/0006）——lobby 之後一律不可重加入。
// 3. 房主退出由剩餘成員中最早加入者繼任（ADR-0007、leave.go 的 update rooms set host_id）：
//    重新加入也拿不回控制權，多人房要講明。單人房沒有人可繼任（房直接刪），不講。
//
// memberCount = null 代表「人數不可判定」（呼叫端沒把成員載成功）。此時兩個方向都不能
// 給無條件承諾：不能說「你是唯一的人」（可能有別人），也不能說「之後可重加入」
//（你可能真的是最後一個，房會被刪、碼會失效）；只能用兩種人數下都成立的條件句。
// isHost = null 同理（呼叫端拿不到 uid，或 uid 還沒載回來）：不猜，退回條件句。
export function leaveNotice(
  status: Room['status'], memberCount: number | null, code: string, isHost: boolean | null,
): string[] {
  const solo = memberCount !== null && memberCount <= 1
  const deletePoint = solo
    ? '你是房間裡唯一的人，離開後這個房間會直接刪除'
    : '你若是最後一位成員，房間會直接被刪除'
  // 肯定句要「確定是房主」且「確定還有別人」；任一不可判定就退回「你若是房主」
  const hostPoint = solo || isHost === false ? null
    : `${isHost && memberCount !== null ? '你是房主：離開後' : '你若是房主，'}`
      + '房主身分會移交給其餘成員中最早加入的人，你重新加入也不會拿回房主權限'
  const withHost = (points: string[]) => hostPoint ? [...points, hostPoint] : points
  if (status === 'lobby') {
    return withHost(solo
      ? [deletePoint,
        `邀請碼 ${code} 會跟著失效，要再約只能重開一場`,
        '你設定的條件也會一起消失']
      : ['你設定的條件會作廢，不再影響這場決策',
        deletePoint,
        memberCount === null
          ? '目前還在等待中：只要房間還在（你不是最後一位），之後仍可用邀請碼重新加入；房主一開始搜尋就不能再加入'
          : '目前還在等待中，之後可用邀請碼重新加入；房主一開始搜尋就不能再加入'])
  }
  if (status === 'decided') {
    return withHost(['你的投票會作廢',
      deletePoint,
      '房間已經開始，離開後無法用邀請碼重新加入，只能另開新房',
      '房間已定案，抽中的結果之後只能在「足跡」查看'])
  }
  // candidates 階段還沒有票（贊成／否決鈕只在 voting 出現，RoomPage 的 CandidateList
  // 只有 voting 才拿到 voting prop）；離席在這裡是條件退出重算（ADR-0007、leave.go 的 rescore）
  if (status === 'candidates') {
    return withHost(solo
      ? [deletePoint,
        '已經跑出來的候選名單會跟著刪除，不會留下任何紀錄',
        '你設定的條件與偏好也會一起消失，離開後無法用邀請碼重新加入']
      : ['你的條件與偏好會退出重算，候選名單會重新分割',
        deletePoint,
        '房間已經開始，離開後無法用邀請碼重新加入，只能另開新房'])
  }
  return withHost(solo
    ? [deletePoint,
      '你的票和整份候選名單會跟著刪除，不會留下任何紀錄',
      '離開後無法用邀請碼重新加入，只能另開新房']
    : ['你的投票會即刻作廢，候選盤面會重新計算',
      deletePoint,
      '房間已經開始，離開後無法用邀請碼重新加入，只能另開新房'])
}

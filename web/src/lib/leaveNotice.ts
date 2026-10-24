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
// 3. 房主退出由剩餘成員繼任，註冊成員優先、再依加入先後（ADR-0007、leave.go 的 update rooms set host_id）：
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
    ? '你是這場聚餐唯一的成員，離開後這場聚餐會直接刪除'
    : '你若是最後一位成員，這場聚餐會直接被刪除'
  // 肯定句要「確定是房主」且「確定還有別人」；任一不可判定就退回「你若是房主」
  const hostPoint = solo || isHost === false ? null
    : `${isHost && memberCount !== null ? '你是發起人：離開後' : '你若是發起人，'}`
      + '發起人身分會移交給其餘成員（已註冊者優先，再依加入先後），你重新加入也不會拿回發起人權限'
  const withHost = (points: string[]) => hostPoint ? [...points, hostPoint] : points
  if (status === 'lobby') {
    return withHost(solo
      ? [deletePoint,
        `邀請碼 ${code} 會跟著失效，要再約只能重開一場`,
        '你設定的條件也會一起消失']
      : ['你設定的條件會作廢，不再影響這場決策',
        deletePoint,
        memberCount === null
          ? '目前還在等待中：只要聚餐還在（你不是最後一位），之後仍可用邀請碼重新加入；發起人一開始搜尋就不能再加入'
          : '目前還在等待中，之後可用邀請碼重新加入；發起人一開始搜尋就不能再加入'])
  }
  // 定案後房間沒有下一步（單次房，ADR-0004）：票、房主移交、末位刪房都不再影響任何人，
  // 同席紀錄也不隨刪房消失（CONTEXT.md 房間）。講了只是嚇人，只留看結果的地方與回不來這件事
  if (status === 'decided') {
    return ['聚餐已定案，抽中的結果之後在「足跡」查看', '離開後就回不到這場聚餐了']
  }
  if (status === 'pending') {
    return withHost(solo
      ? [deletePoint,
        '待確認結果與整份候選名單會跟著刪除，不會寫入足跡',
        '離開後無法用邀請碼重新加入']
      : ['待確認結果不會因你離開而寫入足跡，發起人仍可確認或排除重轉',
        deletePoint,
        '目前無法用邀請碼重新加入；若候選耗盡回到等待階段，同一邀請碼才會重新開放'])
  }
  if (status === 'relocating') {
    return withHost(solo
      ? [deletePoint, '等待選擇的新地點與聚餐條件會一起消失', '離開後無法用邀請碼重新加入']
      : ['你的條件會退出這場重新搜尋', deletePoint,
        '發起人選好新地點並回到等待階段後，只要聚餐還在就能再用同一邀請碼加入'])
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
        '目前無法用邀請碼重新加入；若之後候選耗盡回到等待階段，同一邀請碼才會重新開放'])
  }
  // 初選階段只有圈選、沒有票；開始投票前退房者的圈選即刻作廢（ADR-0010）
  if (status === 'shortlisting') {
    return withHost(solo
      ? [deletePoint,
        '已經跑出來的候選名單與你的圈選會跟著刪除，不會留下任何紀錄',
        '你設定的條件與偏好也會一起消失，離開後無法用邀請碼重新加入']
      : ['你的圈選會作廢，條件與偏好退出重算',
        deletePoint,
        '目前無法用邀請碼重新加入；若之後候選耗盡回到等待階段，同一邀請碼才會重新開放'])
  }
  return withHost(solo
    ? [deletePoint,
      '你的票和整份候選名單會跟著刪除，不會留下任何紀錄',
      '目前無法用邀請碼重新加入；若候選耗盡回到等待階段，同一邀請碼才會重新開放']
    : ['你的投票會即刻作廢，候選盤面會重新計算',
      deletePoint,
      '目前無法用邀請碼重新加入；若候選耗盡回到等待階段，同一邀請碼才會重新開放'])
}

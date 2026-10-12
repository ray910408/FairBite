// 轉盤只在第一次看到這次抽選時播：重新進房（重整、從足跡回來）直接看結果，不必每次等 4 秒。
// 存 localStorage 而不是 state：state 隨 RoomPage 卸載就沒了。每房只記最後看過的版本：
// draw_version 只增不減（抽選、重轉各 +1，從不歸零），>= 就是看過；重轉後的新抽選照樣會播
const key = (roomId: string) => `wheel-seen:${roomId}`

export function wheelSeen(roomId: string, version: number): boolean {
  try {
    const seen = localStorage.getItem(key(roomId))
    return seen !== null && Number(seen) >= version
  } catch {
    return false
  }
}

export function markWheelSeen(roomId: string, version: number): void {
  try {
    localStorage.setItem(key(roomId), String(version))
  } catch {
    // 無痕模式或儲存被封鎖：下次進房照樣重播，不影響結果
  }
}

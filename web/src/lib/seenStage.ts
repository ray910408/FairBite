import type { Room } from './types'

// 這台裝置最後看到的房間階段與 search_version。RoomPage 的換階段 effect 剛掛載時沒有「上一個階段」，
// 拿這個來比，才分得出「離開時還在抽中待確認、回來已經回到準備階段」（候選排光）：
// 伺服器沒有記回到 lobby 的原因，修改條件、換地點也會回到 lobby
export type SeenStage = { status: Room['status']; searchVersion: number }

const key = (roomId: string) => `room-stage:${roomId}`

export function loadSeenStage(roomId: string): SeenStage | undefined {
  try {
    const raw = localStorage.getItem(key(roomId))
    if (!raw) return undefined
    const [status, version] = raw.split('@')
    return { status: status as Room['status'], searchVersion: Number(version) }
  } catch {
    return undefined
  }
}

export function saveSeenStage(roomId: string, status: Room['status'], searchVersion: number | undefined): void {
  try {
    localStorage.setItem(key(roomId), `${status}@${searchVersion}`)
  } catch {
    // 無痕模式或儲存被封鎖：重整後就不補排光說明，其餘照常
  }
}

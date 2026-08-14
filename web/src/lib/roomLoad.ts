// 房間載入結果分類（2026-08-14 QA ISSUE-002）：42703 之類的 DB/網路錯誤
// 不得偽裝成「找不到房間」。PGRST116 = .single() 查無列（房間不存在，或
// RLS 擋掉非成員）→ 這才是真的 not-found。
export type RoomLoadState = 'ok' | 'not-found' | 'error'

export function classifyRoomLoad(data: unknown, error: { code?: string } | null): RoomLoadState {
  if (data) return 'ok'
  if (error && error.code !== 'PGRST116') return 'error'
  return 'not-found'
}

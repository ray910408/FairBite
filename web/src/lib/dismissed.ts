// 「不再提示」清單（首頁的口味建議、評分卡）：逗號分隔存在這台裝置。
// 瀏覽器封鎖網站資料時 localStorage 一碰就丟錯：讀不到當作沒略過，寫不進去就算了，呼叫端照樣先收起
export function readDismissed(key: string): string[] {
  try {
    return (localStorage.getItem(key) ?? '').split(',')
  } catch {
    return []
  }
}

export function addDismissed(key: string, ids: string[]): void {
  try {
    localStorage.setItem(key, [...new Set([...readDismissed(key), ...ids])].filter(Boolean).join(','))
  } catch {
    // 記不住：下次進首頁會再出現
  }
}

export function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase()
}

// 從貼上的文字取出邀請碼：房間標頭的邀請碼鈕複製的是 /join 連結，貼進只收 12 碼的欄位
// 會被 maxLength 截成「https://fair」。不是連結就回 null，交給欄位原本的輸入處理
export function inviteCodeFromLink(text: string): string | null {
  return text.match(/#\/join\/([0-9A-F]{12})(?![0-9A-F])/i)?.[1].toUpperCase() ?? null
}

export function buildInviteUrl(code: string, location?: Pick<Location, 'origin' | 'pathname' | 'search'>): string {
  const current = location ?? (typeof window === 'undefined'
    ? { origin: '', pathname: '', search: '' }
    : window.location)
  return `${current.origin}${current.pathname}${current.search}#/join/${encodeURIComponent(normalizeInviteCode(code))}`
}

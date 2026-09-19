export function normalizeInviteCode(value: string): string {
  return value.trim().toUpperCase()
}

export function buildInviteUrl(code: string, location?: Pick<Location, 'origin' | 'pathname' | 'search'>): string {
  const current = location ?? (typeof window === 'undefined'
    ? { origin: '', pathname: '', search: '' }
    : window.location)
  return `${current.origin}${current.pathname}${current.search}#/join/${encodeURIComponent(normalizeInviteCode(code))}`
}

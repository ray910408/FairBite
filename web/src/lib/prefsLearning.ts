export type HistoryRow = {
  rating: number | null
  restaurants: { cuisine_tags: string[] } | null
}

// 偏好學習（spec §11 P3）：從同席紀錄回填 default_prefs「建議」——
// 只建議、不自動改，採納與否由使用者一鍵決定。
// 規則：吃過 ≥ 2 次、整體排除曾被自己打過低分（≤2 星）的菜系、可選清單內、尚未在偏好中。
export function suggestCuisines(rows: HistoryRow[], current: string[], known: string[]): string[] {
  const lowRated = new Set<string>()
  for (const r of rows) {
    if (r.rating !== null && r.rating <= 2) {
      for (const tag of r.restaurants?.cuisine_tags ?? []) lowRated.add(tag)
    }
  }
  const counts = new Map<string, number>()
  for (const r of rows) {
    if (r.rating !== null && r.rating <= 2) continue
    for (const tag of r.restaurants?.cuisine_tags ?? []) {
      if (lowRated.has(tag) || !known.includes(tag) || current.includes(tag)) continue
      counts.set(tag, (counts.get(tag) ?? 0) + 1)
    }
  }
  return [...counts].filter(([, n]) => n >= 2)
    .sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t]) => t)
}

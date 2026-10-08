// 轉盤 20 色（index.css 的 --wheel-1…20）。超過 20 格時循環取色；
// 轉盤是圓的，最後一格貼著第 0 格——n ≡ 1 (mod 20) 時最後一格會撞第 0 格的色，改取中段色避開兩側鄰居
export const WHEEL_COLORS = 20

export function wheelColorIndex(i: number, n: number): number {
  const k = i % WHEEL_COLORS
  return i === n - 1 && n > 1 && k === 0 ? WHEEL_COLORS / 2 : k
}

export const wheelFill = (i: number, n: number) => `var(--wheel-${wheelColorIndex(i, n) + 1})`
export const wheelInk = (i: number, n: number) => `var(--wheel-ink-${wheelColorIndex(i, n) + 1})`

import { expect, test } from 'vitest'
import { WHEEL_COLORS, wheelColorIndex, wheelFill, wheelInk } from './wheelPalette'

test('任何格數下相鄰兩格（含頭尾相接）不同色；20 格以內每格都不同色', () => {
  for (let n = 1; n <= 60; n++) {
    const idx = Array.from({ length: n }, (_, i) => wheelColorIndex(i, n))
    for (const k of idx) expect(k >= 0 && k < WHEEL_COLORS).toBe(true)
    if (n >= 2) idx.forEach((k, i) => expect(k, `n=${n} i=${i}`).not.toBe(idx[(i + 1) % n]))
    if (n <= WHEEL_COLORS) expect(new Set(idx).size).toBe(n)
  }
})

test('CSS 變數從 1 起算', () => {
  expect(wheelFill(0, 3)).toBe('var(--wheel-1)')
  expect(wheelInk(2, 3)).toBe('var(--wheel-ink-3)')
})

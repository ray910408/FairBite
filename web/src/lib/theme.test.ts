/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'

// theme.ts 在記憶體記著手選結果：每支測試重新載入模組，狀態才不會跨測試外漏
let theme: typeof import('./theme')
beforeEach(async () => {
  vi.resetModules()
  theme = await import('./theme')
})

// index.html 的 inline script 和 applyTheme 各有一份偏好解析；兩份逐案比對，改一邊忘了另一邊會紅
const inlineScript = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)![1]

function stubEnv(stored: string | null, systemDark: boolean, fontSize: string | null = null) {
  const store = new Map<string, string>(stored === null ? [] : [['theme', stored]])
  if (fontSize !== null) store.set('fontSize', fontSize)
  const metas = [0, 1].map(() => {
    const m = { content: '', setAttribute(_name: string, value: string) { m.content = value } }
    return m
  })
  const root = { dataset: {} as Record<string, string> }
  vi.stubGlobal('localStorage', {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => store.set(k, v),
    removeItem: (k: string) => store.delete(k),
  })
  vi.stubGlobal('matchMedia', () => ({ matches: systemDark }))
  vi.stubGlobal('document', { documentElement: root, querySelectorAll: () => metas })
  return {
    store,
    result: () => ({ theme: root.dataset.theme, metas: metas.map(m => m.content) }),
    fontSize: () => root.dataset.fontSize,
  }
}

afterEach(() => vi.unstubAllGlobals())

it.each([
  [null, false, 'light'], [null, true, 'dark'],
  ['light', false, 'light'], ['light', true, 'light'],
  ['dark', false, 'dark'], ['dark', true, 'dark'],
  ['garbage', false, 'light'], ['garbage', true, 'dark'],
])('存 %s、系統深色=%s → %s，inline script 與 applyTheme 一致', (stored, systemDark, expected) => {
  const inline = stubEnv(stored, systemDark)
  new Function(inlineScript)()
  const app = stubEnv(stored, systemDark)
  theme.applyTheme()
  const color = expected === 'dark' ? '#14110f' : '#f4efe4'
  expect(inline.result()).toEqual({ theme: expected, metas: [color, color] })
  expect(app.result()).toEqual(inline.result())
})

it('storage 讀取丟例外時退回跟隨系統；跟隨系統不留 key', () => {
  vi.stubGlobal('localStorage', { getItem() { throw new Error('denied') } })
  expect(theme.getThemePref()).toBe('system')
  const env = stubEnv('dark', false)
  theme.setThemePref('system')
  expect(env.store.has('theme')).toBe(false)
  expect(env.result().theme).toBe('light')
})

it('storage 寫不進去時，手選的主題這次瀏覽仍有效，系統切換不會蓋掉', () => {
  const env = stubEnv(null, false)
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() { throw new Error('quota') }, removeItem() {} })
  theme.setThemePref('dark')
  theme.applyTheme() // initTheme 的系統切換監聽器就是這樣呼叫
  expect(env.result().theme).toBe('dark')
  expect(theme.getThemePref()).toBe('dark')
})

it.each([
  [null, 'md'], ['md', 'md'], ['lg', 'lg'], ['xl', 'xl'], ['sm', 'md'], ['garbage', 'md'],
])('字級存 %s → %s，inline script 與 applyFontSize 一致', (stored, expected) => {
  const inline = stubEnv(null, false, stored)
  new Function(inlineScript)()
  const app = stubEnv(null, false, stored)
  theme.applyFontSize()
  expect(inline.fontSize()).toBe(expected)
  expect(app.fontSize()).toBe(expected)
})

it('字級選標準不留 key；storage 寫不進去時這次瀏覽仍有效', () => {
  const env = stubEnv(null, false, 'xl')
  theme.setFontSizePref('md')
  expect(env.store.has('fontSize')).toBe(false)
  expect(env.fontSize()).toBe('md')
  vi.stubGlobal('localStorage', { getItem: () => null, setItem() { throw new Error('quota') }, removeItem() {} })
  theme.setFontSizePref('lg')
  expect(env.fontSize()).toBe('lg')
  expect(theme.getFontSizePref()).toBe('lg')
})

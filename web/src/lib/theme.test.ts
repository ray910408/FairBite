/// <reference types="node" />
import { readFileSync } from 'node:fs'
import { afterEach, expect, it, vi } from 'vitest'
import { applyTheme, getThemePref, setThemePref } from './theme'

// index.html 的 inline script 和 applyTheme 各有一份偏好解析；兩份逐案比對，改一邊忘了另一邊會紅
const inlineScript = readFileSync(new URL('../../index.html', import.meta.url), 'utf8')
  .match(/<script>([\s\S]*?)<\/script>/)![1]

function stubEnv(stored: string | null, systemDark: boolean) {
  const store = new Map(stored === null ? [] : [['theme', stored]])
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
  return { store, result: () => ({ theme: root.dataset.theme, metas: metas.map(m => m.content) }) }
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
  applyTheme()
  const color = expected === 'dark' ? '#14110f' : '#f4efe4'
  expect(inline.result()).toEqual({ theme: expected, metas: [color, color] })
  expect(app.result()).toEqual(inline.result())
})

it('跟隨系統不留 key；storage 丟例外時退回跟隨系統', () => {
  const env = stubEnv('dark', false)
  setThemePref('system')
  expect(env.store.has('theme')).toBe(false)
  expect(env.result().theme).toBe('light')
  vi.stubGlobal('localStorage', { getItem() { throw new Error('denied') } })
  expect(getThemePref()).toBe('system')
})

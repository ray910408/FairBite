// 主題偏好：light／dark 存 localStorage，system（預設）不存、跟著 prefers-color-scheme。
// index.css 只看 <html data-theme>；首次繪製前由 index.html 的 inline script 先套一次，避免深色使用者閃一下米紙底
export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'theme'
const systemDark = () => matchMedia('(prefers-color-scheme: dark)')
// 這次瀏覽手選過就以它為準：storage 寫不進去時，系統切換觸發的 applyTheme() 才不會讀回舊值蓋掉手選
let chosen: ThemePref | null = null

export function getThemePref(): ThemePref {
  if (chosen) return chosen
  try {
    const v = localStorage.getItem(KEY)
    if (v === 'light' || v === 'dark') return v
  } catch { /* 隱私模式讀不到就跟隨系統 */ }
  return 'system'
}

export function applyTheme(pref = getThemePref()) {
  const dark = pref === 'dark' || (pref === 'system' && systemDark().matches)
  document.documentElement.dataset.theme = dark ? 'dark' : 'light'
  // 手選的主題可能和系統相反：兩個帶 media 的 theme-color 都改成同色，網址列才會跟著選擇走
  document.querySelectorAll('meta[name="theme-color"]')
    .forEach(m => m.setAttribute('content', dark ? '#14110f' : '#f4efe4'))
}

export function setThemePref(pref: ThemePref) {
  chosen = pref
  try {
    if (pref === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch { /* 存不了就只在這次瀏覽生效 */ }
  applyTheme(pref)
}

// 字級：md（預設）不存。只放大不縮小：縮小會讓 44px 觸控目標變小、Places 歸屬字跌破 12px 下限
export type FontSizePref = 'md' | 'lg' | 'xl'

const FONT_KEY = 'fontSize'
let chosenFontSize: FontSizePref | null = null

export function getFontSizePref(): FontSizePref {
  if (chosenFontSize) return chosenFontSize
  try {
    const v = localStorage.getItem(FONT_KEY)
    if (v === 'lg' || v === 'xl') return v
  } catch { /* 讀不到就用標準 */ }
  return 'md'
}

export function applyFontSize(pref = getFontSizePref()) {
  document.documentElement.dataset.fontSize = pref
}

export function setFontSizePref(pref: FontSizePref) {
  chosenFontSize = pref
  try {
    if (pref === 'md') localStorage.removeItem(FONT_KEY)
    else localStorage.setItem(FONT_KEY, pref)
  } catch { /* 存不了就只在這次瀏覽生效 */ }
  applyFontSize(pref)
}

// 跟隨系統時，系統切深淺要即時反映；手選時 applyTheme 讀到的偏好不是 system，事件等於 no-op
export function initTheme() {
  applyTheme()
  applyFontSize()
  systemDark().addEventListener('change', () => applyTheme())
}

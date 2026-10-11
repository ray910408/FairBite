// 主題偏好：light／dark 存 localStorage，system（預設）不存、跟著 prefers-color-scheme。
// index.css 只看 <html data-theme>；首次繪製前由 index.html 的 inline script 先套一次，避免深色使用者閃一下米紙底
export type ThemePref = 'system' | 'light' | 'dark'

const KEY = 'theme'
const systemDark = () => matchMedia('(prefers-color-scheme: dark)')

export function getThemePref(): ThemePref {
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
  try {
    if (pref === 'system') localStorage.removeItem(KEY)
    else localStorage.setItem(KEY, pref)
  } catch { /* 存不了就只在這次瀏覽生效 */ }
  applyTheme(pref)
}

// 跟隨系統時，系統切深淺要即時反映；手選時 applyTheme 讀到的偏好不是 system，事件等於 no-op
export function initTheme() {
  applyTheme()
  systemDark().addEventListener('change', () => applyTheme())
}

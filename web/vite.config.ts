import { createHash } from 'node:crypto'
import type { Plugin } from 'vite'
import { configDefaults, defineConfig } from 'vitest/config'
import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const proxy = {
  '/healthz': {
    target: 'http://127.0.0.1:8787',
    changeOrigin: true,
  },
  '/api': {
    target: 'http://127.0.0.1:8787',
    changeOrigin: true,
  },
  '/supabase': {
    target: 'http://127.0.0.1:54321',
    changeOrigin: true,
    ws: true,
    rewrite: (path: string) => path.replace(/^\/supabase/, ''),
  },
}

// 縱深防禦：GitHub Pages 不能設 header，build 產物用 <meta> CSP，主要靠 connect-src 白名單擋 token 外送。
// 只在 build 注入（dev 的 HMR 要 inline script 與 websocket）；meta 裡 frame-ancestors 無效，不放。
// inline script 以 sha256 放行：HTML 解析會把 CRLF 正規化成 LF，雜湊要對正規化後的內容算（Windows checkout 是 CRLF）。
function contentSecurityPolicy(): Plugin {
  let env: Record<string, string> = {}
  // 絕對網址取 origin；相對路徑（本機 /api、/supabase 走 proxy）或未設就是同源，'self' 已涵蓋
  const origin = (url = '') => (url && !url.startsWith('/') ? [new URL(url).origin] : [])
  return {
    name: 'content-security-policy',
    apply: 'build',
    configResolved(config) {
      env = config.env
    },
    transformIndexHtml: {
      order: 'post',
      handler(html) {
        const hashes = [...html.matchAll(/<script(?![^>]*\ssrc=)[^>]*>([\s\S]*?)<\/script>/g)].map(([, body]) =>
          `'sha256-${createHash('sha256').update(body.replace(/\r\n?/g, '\n')).digest('base64')}'`)
        const supabase = origin(env.VITE_SUPABASE_URL)
        const policy = [
          "default-src 'self'",
          `script-src 'self' ${hashes.join(' ')}`,
          "style-src 'self' https://fonts.googleapis.com",
          "font-src 'self' https://fonts.gstatic.com",
          "img-src 'self' data: https://tile.openstreetmap.org",
          // Realtime 走 wss；Nominatim 是出發點地名搜尋（lib/departure.ts）
          ['connect-src', "'self'", ...supabase, ...supabase.map(o => o.replace(/^http/, 'ws')),
            ...origin(env.VITE_API_URL), 'https://nominatim.openstreetmap.org'].join(' '),
          "object-src 'none'",
          "base-uri 'self'",
          "form-action 'self'",
        ].join('; ')
        // 插在 charset 之後：charset 宣告要落在檔案前 1024 bytes 內
        return html.replace(/<meta charset[^>]*>/, m => `${m}\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`)
      },
    },
  }
}

export default defineConfig({
  // GitHub Pages 是 project site（/FairBite/ 子路徑），相對 base 讓資產不綁死路徑；
  // Vite 對 './' 有特例：dev 仍當成 '/'，只影響 build 產物。
  base: './',
  plugins: [basicSsl(), react(), tailwindcss(), contentSecurityPolicy()],
  // host 只綁迴環：同網段的人不能經 dev proxy 打本機 API、用掉真的 Places key。明寫 127.0.0.1 而不用預設的
  // localhost：Windows 上 localhost 只綁 ::1，README 與 Auth redirect 用的 https://127.0.0.1:5173 會連不上
  //（瀏覽器開 localhost 會自動退回 127.0.0.1）。手機測試用 dev.ps1 -Lan，它會加 --host 綁 0.0.0.0。
  // open: 啟動完成後自動開 https://127.0.0.1:5173（和 localhost 是不同 origin，登入狀態各自獨立；
  // 手機端仍需手動輸入區網 IP）。
  server: {
    host: '127.0.0.1',
    open: true,
    proxy,
  },
  preview: { proxy },
  build: {
    rolldownOptions: {
      output: {
        codeSplitting: {
          // 第三方套件獨立成 vendor：多數部署只改 app 碼，回訪者不必重抓 React／Supabase。
          // $initial 只收入口靜態相依鏈上的套件——leaflet（展開地圖才 dynamic import）不會被併進首屏
          groups: [{ name: 'vendor', test: /node_modules/, tags: ['$initial'] }],
        },
      },
    },
  },
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})

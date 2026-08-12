import { configDefaults, defineConfig } from 'vitest/config'
import basicSsl from '@vitejs/plugin-basic-ssl'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

const proxy = {
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

export default defineConfig({
  // GitHub Pages 是 project site（/FairBite/ 子路徑），相對 base 讓資產不綁死路徑；
  // Vite 對 './' 有特例：dev 仍當成 '/'，只影響 build 產物。
  base: './',
  plugins: [basicSsl(), react(), tailwindcss()],
  // host: 綁 0.0.0.0 讓同網段手機連得到；open: 啟動完成後自動開瀏覽器。
  // open 只會開 localhost（Vite 的 open 字串是 pathname 不是完整 URL），手機端仍需手動輸入區網 IP。
  server: {
    host: true,
    open: true,
    proxy,
  },
  preview: { proxy },
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})

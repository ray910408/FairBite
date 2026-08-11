import { configDefaults, defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // host: 綁 0.0.0.0 讓同網段手機連得到；open: 啟動完成後自動開瀏覽器。
  // open 只會開 localhost（Vite 的 open 字串是 pathname 不是完整 URL），手機端仍需手動輸入區網 IP。
  server: { host: true, open: true },
  test: {
    exclude: [...configDefaults.exclude, 'e2e/**'],
  },
})

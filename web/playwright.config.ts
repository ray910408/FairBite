import { defineConfig } from '@playwright/test'

// 前置：supabase start + go server + vite dev 都在跑（見 README「E2E 測試」）
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  workers: 1, // 兩個 context 共享一個測試房間，不平行
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:5173',
    ignoreHTTPSErrors: true, // 本地 Vite 使用 @vitejs/plugin-basic-ssl 的自簽憑證
  },
})

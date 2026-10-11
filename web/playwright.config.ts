import { defineConfig } from '@playwright/test'

// 前置：supabase start + go server + vite dev 都在跑（見 README「E2E 測試」）
export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 10_000 },
  // 每個 test 自己註冊帳號、自己開房，彼此不共用狀態，可以拆到不同 worker 平行跑。
  // 上限 3：全域同時搜尋上限是 4（concurrent_search_limit），CI runner 也只有 4 vCPU 還要跑整套 stack
  fullyParallel: true,
  workers: 3,
  use: {
    baseURL: process.env.PLAYWRIGHT_BASE_URL ?? 'https://localhost:5173',
    ignoreHTTPSErrors: true, // 本地 Vite 使用 @vitejs/plugin-basic-ssl 的自簽憑證
  },
})

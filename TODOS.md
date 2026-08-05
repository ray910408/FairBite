# TODOS

## P2 候選

### Playwright 多客戶端 E2E（完整閉環自動化）

- **What:** 自動化雙瀏覽器完整閉環測試：建房 → 邀請碼加入 → 雙人條件 → 搜尋 → 候選同步 → 抽選 → 結果同步 → Maps 連結。
- **Why:** P1 閉環驗證只有手動 demo script（spec §9 明定 P1 手動）。每次改動手動跑 3 分鐘 × N 次的隱性成本，長期會超過寫一次 E2E 的成本。auth + realtime + 多客戶端同步正是 E2E 決策矩陣建議自動化的類型。
- **Pros:** 回歸保護最強的一層；demo 前可先跑一次確保流程活著。
- **Cons:** Playwright 多 browser context + Supabase local stack 編排，前置設定複雜；CI 上需要起整套 local stack。
- **Context:** 手動流程見 `docs/demo-script.md`；測試重點清單見 `~/.gstack/projects/app/kenne-main-eng-review-test-plan-20260805-201029.md`。起點：Playwright 兩個 `browser.newContext()` 模擬兩位使用者，對 `localhost:5173` 走完 demo script 的九步。
- **Depends on / blocked by:** Phase 1 全部 task 完成後才有意義（2026-08-05 記錄）。

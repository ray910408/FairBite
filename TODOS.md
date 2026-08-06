# TODOS

## P2 候選

### Playwright 多客戶端 E2E（完整閉環自動化）

- **What:** 自動化雙瀏覽器完整閉環測試：建房 → 邀請碼加入 → 雙人條件 → 搜尋 → 候選同步 → 抽選 → 結果同步 → Maps 連結。
- **Why:** P1 閉環驗證只有手動 demo script（spec §9 明定 P1 手動）。每次改動手動跑 3 分鐘 × N 次的隱性成本，長期會超過寫一次 E2E 的成本。auth + realtime + 多客戶端同步正是 E2E 決策矩陣建議自動化的類型。
- **Pros:** 回歸保護最強的一層；demo 前可先跑一次確保流程活著。
- **Cons:** Playwright 多 browser context + Supabase local stack 編排，前置設定複雜；CI 上需要起整套 local stack。
- **Context:** 手動流程見 `docs/demo-script.md`；測試重點清單見 `~/.gstack/projects/app/kenne-main-eng-review-test-plan-20260805-201029.md`。起點：Playwright 兩個 `browser.newContext()` 模擬兩位使用者，對 `localhost:5173` 走完 demo script 的九步。
- **Depends on / blocked by:** Phase 1 全部 task 完成後才有意義（2026-08-05 記錄）。

### Final review 遞延（2026-08-06）

feat/phase-1 全分支 final review 的 DEFER-P2 批次。前三項優先（安全/依賴面），其餘為測試缺口與 UX 細節。逐條出處見 `.superpowers/sdd/2026-08-05-phase1-demo-loop/progress.md`。

優先：

1. **join_room 走 PostgREST，不受應用層限流** — Go 的 rate limiter 只護 `/api/*`；join_room 是 RPC 直打 PostgREST，邀請碼有列舉面。要在 DB 層或 gateway 補限流。
2. **react-router RSC CVE（GHSA-qwww-vcr4-c8h2）為 production dep** — P1 純 SPA 用不到 RSC 路徑，hosted/SSR 上線前必須重評並升版。
3. **rooms 欄級 grant + 平台預設 TRUNCATE revoke** — 現行 UPDATE grant 比意圖粗（可改 created_at）；anon/authenticated 持有平台預設 TRUNCATE（NOLOGIN + PostgREST 不發，目前不可達）。

其餘：

4. `NewVerifier` 的 `len(secret) < 32` 拒啟動分支無測試。
5. `guard_room_columns` 無 `set search_path`（不可利用，linter 會唸）。
6. `handle_new_user` 保留預設 `EXECUTE TO PUBLIC`（returns trigger 不可直呼，僅不一致）。
7. grant 矩陣 pin 只盯 `grantee='authenticated'`，grant to PUBLIC 的放寬不會觸發。
8. `MinutesUntilClose` 的 `-1`（未營業）路徑無測試。
9. 引擎正向保留路徑無測試（具 `vegetarian_friendly` 應保留、雙衝突 tag = 2 reasons 1 kind、Kinds 集合內容）。
10. 抽選無「壞 seed 非空清單」與「打亂順序同 winner」回歸測試。
11. 並發 draw 的 23505 / transition conflict 無實測（僅狀態前置檢查覆蓋）。
12. `[]` / `null` 契約無測試斷言（現有測試 excluded/kept 皆非空）。
13. createRoom 錯誤訊息透傳 raw message，與 join 不對稱。
14. 條件表單輸入框無 label，僅 placeholder。
15. unmount 未清 debounce timer。
16. 搜尋鈕無 in-flight guard（可連按）。
17. 首次掛載期的暫時性讀取失敗會閃「找不到房間」頁 — 應三態化（loading / notFound / ok）。
18. `Wheel` 的 `!s` 分支是 dead-end（實務不可達）。

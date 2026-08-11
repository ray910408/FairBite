# TODOS

## P2 eng review 新增（2026-08-06）

- ~~舊房間（>30 天）重開時仍顯示過期的 Google 快取內容~~ 已結案：產品決策（2026-08-10）不支援舊房重開（ADR-0004），不實作重刷或過期標註。

- Google currentOpeningHours（假日/特別時段）與 30 天快取條款結構性衝突 — date-specific 時段需要獨立的短效快取語意，留待 P3 設計（regularOpeningHours 的假日誤差為本期接受的限制）。
  P3 明確排除：需要獨立的短效快取設計輪。

- ~~**dining_history 刪除語意：** `dining_history.room_id` 目前 `on delete cascade`（0003 migration），與 ADR-0002「紀錄跟人」矛盾~~ 已解決：migration 0011 改為 nullable + `on delete set null`（本 commit）。

- **restaurants.cuisine_tags 無 jsonb 元素型別 CHECK：** 0001 連 array CHECK 都沒有；D5 的論證同樣適用，但僅 service role 寫入且來源為 Google Places，風險低。下次修改 `restaurants` schema 時順手補。

- **晚餐/其他時段 × 菜系加成：** 待 provider tag 詞彙擴充、`googleTypeTags` 有真實對映後回歸；新增 slot 的前置條件已註記於 `server/weights.go`（P3 eng review D23）。

- **均勻倍率 chip 策略：** timeslot 全場命中、rain 全場飽和、「推薦過但尚未中選」穩態 chip 三案併為一次決策：由引擎 guard 或 web 端過濾（P3 batch 1 final review）。

### Google Places attribution logo 確認（正式上線前）

- **What:** 依當時最新版 Google 品牌指南確認「Powered by Google」logo 資產與使用方式；目前 UI 已依 `place_id` 自動為 Google 來源資料顯示文字歸因。
- **Why:** 品牌資產與規範可能更新，正式上線前需以當時版本做最後確認。
- **Depends on:** hosted 正式上線計畫。

### limiter map TTL 清理（hosted 前）

- **What:** `server/handlers.go` 的 `limiterStore` per-user map 加 TTL 清理（程式內 ponytail 註解已標「P2 部署時加」）。
- **Why:** 長時間運行的 hosted 部署下，每個曾出現的 user id 永久佔一個 limiter → 緩慢記憶體洩漏。本機/demo 無感。
- **Pros:** 上線前 checklist 自動浮現；修法簡單（last-seen 時間戳 + lazy 清理）。
- **Cons:** 純預防性，當下量測不出差異。
- **Context:** 起點 `server/handlers.go:15-30`；與 Places budget alert 同屬「hosted 上線前」群。
- **Depends on:** hosted 部署計畫（目前無時程）。

### E2E 降級快取情境（provider 斷線編排）

- **What:** Playwright 補「Places 失敗 → 30 天快取 fallback → 降級橫幅」的自動化情境。
- **Why:** 伺服器端降級鏈已有 Go 測試，但「使用者看到橫幅」這最後一哩只有手動驗證（2026-08-06 eng review D10 認定值得自動化、成本高於當批範圍）。
- **Pros:** 降級鏈全程進回歸網。
- **Cons:** 需讓 Go server 的 provider 中途失效——測試旗標（如 `PLACES_FORCE_FAIL=1`）或雙 server 編排，基建成本高。
- **Context:** 起點：`server/main.go` provider 切換處加測試旗標；E2E 前置腳本以該旗標啟動第二個 port。
- **Depends on:** P2 Task 13 完成；與既有「E2E 接 CI」註記可合併評估。

### Places 花費防線：budget alert + cache-first 評估（hosted 前）

- **What:** GCP 帳務預算警報（純 ops）；並評估 cache-first 搜尋策略（快取夠新鮮夠密時跳過 API 呼叫）。
- **Why:** 每次 search 是一次 Nearby Search Pro SKU 計費呼叫（FieldMask 含 regularOpeningHours/rating）。個人規模趨近零成本，hosted 開放他人用後無任何花費防線（2026-08-06 outside voice #8）。
- **Pros:** 第一層（alert）零程式碼。
- **Cons:** cache-first 涉及「快取是否涵蓋該區域」判定與營業時間新鮮度取捨，屬產品決策——當批已明確拒絕立即重設計。
- **Context:** search 每房僅一次且被狀態機閘住，濫用面已小。
- **Depends on:** hosted 部署；與 limiter TTL 同群。

## P2 候選

### ~~Playwright 多客戶端 E2E（完整閉環自動化）~~

已完成（PR #3，2026-08-10）：`web/e2e/full-loop.spec.ts` 走完雙 browser context 的
註冊 → 建房/加入 → 探索檔位 → 條件 → 搜尋 → 投票（贊成/否決/收回/額度/全否決防線）
→ 抽選 → 結果同步 → Maps 導航，執行方式見 `README.md` 的「E2E 測試」。
殘留：尚未接 CI（需編排整套 local stack），與下方「E2E 降級快取情境」合併評估。原始評估：

- **What:** 自動化雙瀏覽器完整閉環測試：建房 → 邀請碼加入 → 雙人條件 → 搜尋 → 候選同步 → 抽選 → 結果同步 → Maps 連結。
- **Why:** P1 閉環驗證只有手動 demo script（spec §9 明定 P1 手動）。每次改動手動跑 3 分鐘 × N 次的隱性成本，長期會超過寫一次 E2E 的成本。auth + realtime + 多客戶端同步正是 E2E 決策矩陣建議自動化的類型。
- **Pros:** 回歸保護最強的一層；demo 前可先跑一次確保流程活著。
- **Cons:** Playwright 多 browser context + Supabase local stack 編排，前置設定複雜；CI 上需要起整套 local stack。
- **Context:** 手動流程見 `docs/demo-script.md`；測試重點清單見 `~/.gstack/projects/app/kenne-main-eng-review-test-plan-20260805-201029.md`。起點：Playwright 兩個 `browser.newContext()` 模擬兩位使用者，對 `localhost:5173` 走完 demo script 的九步。
- **Depends on / blocked by:** Phase 1 全部 task 完成後才有意義（2026-08-05 記錄）。

### Final review 遞延（2026-08-06）

feat/phase-1 全分支 final review 的 DEFER-P2 批次。前三項優先（安全/依賴面），其餘為測試缺口與 UX 細節。逐條出處見本機 `docs/superpowers/sdd-ledger-phase1.md`（未納入版控）。

優先：

1. **join_room 走 PostgREST，不受應用層限流** — Go 的 rate limiter 只護 `/api/*`；join_room 是 RPC 直打 PostgREST，邀請碼有列舉面。要在 DB 層或 gateway 補限流。
2. ~~**react-router RSC CVE（GHSA-qwww-vcr4-c8h2）為 production dep**~~ — 已解決：升級至 7.18.2，2026-08-09 驗證 `npm audit` clean。
3. **rooms 欄級 grant + 平台預設 TRUNCATE revoke** — 現行 UPDATE grant 比意圖粗（可改 created_at）；anon/authenticated 持有平台預設 TRUNCATE（NOLOGIN + PostgREST 不發，目前不可達）。

其餘：

4. `NewVerifier` 的 `len(secret) < 32` 拒啟動分支無測試。
5. `guard_room_columns` 無 `set search_path`（不可利用，linter 會唸）。（P2 計畫已吸收：Task 2 重寫該函式時順手補，2026-08-06 eng review D5）
6. `handle_new_user` 保留預設 `EXECUTE TO PUBLIC`（returns trigger 不可直呼，僅不一致）。
7. grant 矩陣 pin 只盯 `grantee='authenticated'`，grant to PUBLIC 的放寬不會觸發。
8. `MinutesUntilClose` 的 `-1`（未營業）路徑無測試。
9. 引擎正向保留路徑無測試（具 `vegetarian_friendly` 應保留、雙衝突 tag = 2 reasons 1 kind、Kinds 集合內容）。
10. 抽選無「壞 seed 非空清單」與「打亂順序同 winner」回歸測試。
11. 並發 draw 的 23505 / transition conflict 無實測（僅狀態前置檢查覆蓋）。
12. `[]` / `null` 契約無測試斷言（現有測試 excluded/kept 皆非空）。
13. createRoom 錯誤訊息透傳 raw message，與 join 不對稱。
14. **UI 元件測試基建（@testing-library + jsdom）一次性補全** — slider label、toggle `aria-pressed`、auth/home `aria-label` 已於 2026-08-06 /qa 處理；殘留料理/禁忌群組的程式化關聯，與 RatingPrompt、RecentRatingPrompt、偏好建議橫幅、`applyDefaultPrefs` 的元件層零自動化覆蓋一次補全。偏好建議橫幅 UI 膠水依既有 test-plan artifact 手動 QA，不另上 E2E（P3 eng review D14/D15）。
15. unmount 未清 debounce timer。
16. ~~搜尋鈕無 in-flight guard（可連按）~~ — 已解決：`RoomPage.tsx` 的 `searchInFlight` ref 擋連按（7e322c4），伺服器端另有 per-room single-flight（`TestSearchSingleFlightPerRoom`），E2E 斷言快速連點只送一次 request。
17. ~~首次掛載期的暫時性讀取失敗會閃「找不到房間」頁 — 應三態化（loading / notFound / ok）~~ — 已解決：`useRoom.ts` 回傳 `notFound`，`RoomPage.tsx:53` 僅在 `notFound` 為真時顯示該頁。
18. `Wheel` 的 `!s` 分支是 dead-end（實務不可達）。

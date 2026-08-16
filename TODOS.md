# TODOS

## P2 eng review 新增（2026-08-06）

- ~~舊房間（>30 天）重開時仍顯示過期的 Google 快取內容~~ 已結案：產品決策（2026-08-10）不支援舊房重開（ADR-0004），不實作重刷或過期標註。

- Google currentOpeningHours（假日/特別時段）與 30 天快取條款結構性衝突 — date-specific 時段需要獨立的短效快取語意，留待 P3 設計（regularOpeningHours 的假日誤差為本期接受的限制）。
  P3 明確排除：需要獨立的短效快取設計輪。

- ~~**dining_history 刪除語意：** `dining_history.room_id` 目前 `on delete cascade`（0003 migration），與 ADR-0002「紀錄跟人」矛盾~~ 已解決：migration 0011 改為 nullable + `on delete set null`（本 commit）。

- ~~**房間清理政策的前置：** 刪房會使 `restaurants_select`（0005）對舊紀錄的巢狀讀取失效（room_candidates cascade 消失）——實作清理時需同步決定 restaurants 的歷史可見性（web 偏好學習與 RecentRatingPrompt 依賴 embed；程式已優雅降級但訊號會靜默流失）。2026-08-11 batch2 final review 發現。Round 2 足跡頁（/history）清單同樣依賴此 embed，波及面擴大為全史最多 500 筆——屆時整頁餐廳名降級為「（餐廳已下架）」。~~ 已結案（2026-08-15）：Round 4 退房制（ADR-0007）以 0022 restaurants_select 的 dining_history 條款解除前置，房刪後歷史 embed 不再降級。

- ~~**restaurants.cuisine_tags 無 jsonb 元素型別 CHECK：** 0001 連 array CHECK 都沒有；D5 的論證同樣適用，但僅 service role 寫入且來源為 Google Places，風險低。下次修改 `restaurants` schema 時順手補。~~ 已結案：migration 0021 已補上元素型別 CHECK。

- **晚餐/其他時段 × 菜系加成：** 待 provider tag 詞彙擴充、`googleTypeTags` 有真實對映後回歸；新增 slot 的前置條件已註記於 `server/weights.go`（P3 eng review D23）。（2026-08-13：hotpot 已有真實映射，前置滿足；開 slot 與否仍是獨立產品決策。）

- **均勻倍率 chip 策略：** timeslot 全場命中、rain 全場飽和、「推薦過但尚未中選」穩態 chip 三案併為一次決策：由引擎 guard 或 web 端過濾（P3 batch 1 final review）。

- ~~**dining_history 排序索引**：足跡頁查詢為 `user_id` 過濾＋`decided_at` 排序，既有 `dining_history_recency (user_id, restaurant_id, decided_at)` 中欄卡住排序用不上；個人規模無感，下次動 `dining_history` schema 時順手補 `(user_id, decided_at desc)`（2026-08-14 Round 2 eng review）。~~ 已結案（2026-08-15）：0022 順手補 `(user_id, decided_at desc)`。

- ~~CUISINE 選項的 Google 缺口~~ 已結案（2026-08-13）：cantonese/hotpot 補真實映射（0018 回填）、sichuan 移除；tags_test gap pin 清空。

### Round 3 審查遞延（2026-08-15）

- ~~**連鎖去重早於歇業 tombstone 收集**：`dedupeChains` 在 provider 內先於 `closedIDs` 收集；被連鎖去重丟棄的歇業分店逃過 tombstone，快取可能殘留至多 30 天（TTL 自癒）。~~ 已結案（2026-08-15）：本輪讓 `dedupeChains` 回傳落選歇業分店的 `place_id`，由 handler 併入 `closedIDs` 做 tombstone。

- **無名店 chain key 碰撞**：`chainKey("")` 會把多家 `displayName` 缺漏的無名店塌成一家；Google 幾乎必回 `displayName`，機率低。修法：key 為空時跳過 dedupe。

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

### vote 回應的 vetoes_remaining 未被 web 消費（arch review，2026-08-11）

- **What:** 審查建議讓 web 消費 vote 回應的 `vetoes_remaining`，取代目前由票列本地推導剩餘否決額度。
- **Why:** 多分頁或 Realtime 中斷時，本地推導的剩餘額度會落後真實值。現況依 ADR-0003（`docs/adr/0003-centralized-vote-write-command.md`）：payload 仍是 API contract 的一部分，但 web 不消費，成功後靠 Realtime + debounce refetch 對齊。若日後出現實際回報再改。

## Round 1 final review 遞延（2026-08-13）

- **LocationPicker 錯誤處理 polish 三合一**：Leaflet dynamic import 加 `.catch`（現為灰框靜默）、searchPlaces 逾時/離線錯誤中文化（現原文英文直出）、錯誤訊息補 `role="alert"`。起點 `web/src/components/LocationPicker.tsx`。
- **雙頁時/分 select JSX 抽共用元件**：HomePage/RoomPage 各 18 行複製；第三處出現再動手。
- ~~**E2E 地圖渲染守門**：full-loop 補一行 `.leaflet-container` visible 斷言（原斷言在選點器改版時被刪）。~~ 已結清（Round 2 Task 5 捆綁）。
- ~~**mealTimeForE2E 守門加 +60s 緩衝**：`t <= now` 瞬時比較在每日 19:55–20:00 有數秒級 flaky 窗口。~~ 已結清（Round 2 Task 5 捆綁）。
- ~~**mockdata mock-008 的 sichuan 詞彙孤兒**：下次動 mockdata.go 時順手清。~~ 已結案：Round 3 Task 3 移除孤兒 tag，保留 hotpot。

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
14. **UI 元件測試基建（@testing-library + jsdom）一次性補全** — slider label、toggle `aria-pressed`、auth/home `aria-label` 已於 2026-08-06 /qa 處理；殘留料理/禁忌群組的程式化關聯，與 RatingPrompt、RecentRatingPrompt、偏好建議橫幅、`applyDefaultPrefs` 的元件層零自動化覆蓋一次補全。偏好建議橫幅 UI 膠水依既有 test-plan artifact 手動 QA，不另上 E2E（P3 eng review D14/D15）。Round 2 足跡頁新增缺口一併納入：HistoryPage 載入／錯誤＋重試／空狀態／>500 footer 四態，與清單列 StarRow 錯誤分支；另 Round 2 E2E 重排後，房內 RatingPrompt 的互動寫入分支（點星後 onRated=setRating 即時切靜態文案的膠水）E2E 覆蓋歸零，批次補全時一併恢復。Round 4 新增：RoomPage 搜尋中（searching）房間設定控制 disabled 的元件斷言一併納入批次。
15. unmount 未清 debounce timer。
16. ~~搜尋鈕無 in-flight guard（可連按）~~ — 已解決：`RoomPage.tsx` 的 `searchInFlight` ref 擋連按（7e322c4），伺服器端另有 per-room single-flight（`TestSearchSingleFlightPerRoom`），E2E 斷言快速連點只送一次 request。
17. ~~首次掛載期的暫時性讀取失敗會閃「找不到房間」頁 — 應三態化（loading / notFound / ok）~~ — 已解決：`useRoom.ts` 回傳 `notFound`，`RoomPage.tsx:53` 僅在 `notFound` 為真時顯示該頁。
18. `Wheel` 的 `!s` 分支是 dead-end（實務不可達）。

## /qa-only 線上站 QA + PR #17 review 殘留（2026-08-16）

QA 對象 https://ray910408.github.io/FairBite/#/auth（headless，test 帳號）。ISSUE 編號對應 `.gstack/qa-reports/qa-report-fairbite-2026-08-16.md`（該目錄被 .gitignore 蓋住，只在本機）。PR #17 已修 ISSUE-001（回首頁離席確認）與 ISSUE-003（星排視覺）。

- **ISSUE-002（High，未修）預設條件產生退化結果集** — 全預設（NT$300 上限／800m／步行）在台北 101 搜尋，15 家排除 14 家、全部理由都是「超過 NT$300」，只剩 1 家候選、抽中機率 100%。轉盤只有一個選項等於產品主張不成立，且 App 沒有任何「候選過少、建議放寬條件」的提示就讓使用者走到投票與轉盤。需要產品決策：調預設值、依商圈動態調整、或加候選過少的引導。

- **ISSUE-005（Low）足跡頁把 3/5 星畫成 3 顆滿星** — `HistoryPage.tsx` 的清單列只渲染 N 顆實心星、沒有空心星做 5 星刻度，3 分讀起來像滿分。摘要區的「平均 3.0 ★」正確，只有列表圖示缺刻度。`icons.tsx` 的 `Star` 已有 `filled` prop（PR #17 加的），補刻度是小改。

- **ISSUE-006（Low，間歇）冷啟動首次登入 `dining_history?rating=lte.2` 回 401** — 全新瀏覽器 process 首次登入時觀察到一次（該次首頁 HTML 載入 7489ms），相鄰的同表查詢是 200。像是這支請求在 token 掛上去前就送出的競態；畫面無提示，只有 console 一行 401，影響是「避開不喜歡的菜系」訊號被靜默丟掉。清 localStorage 重登／登出重登／重整各測一次都無法重現。

- **ISSUE-007（Low）邀請碼錯誤橫幅不會消失** — 「房間不存在或已開始」在首頁一直停留到換路由，中間展開地圖、搜尋地點、切用餐時間、觸發另一則驗證訊息期間都還在，跟當下操作已無關。

- **ISSUE-008（Low）邀請碼欄位無長度／格式驗證** — 實際碼是 12 碼，輸入 6 碼仍會送出 `rpc/join_room`。前端可先擋掉省一次往返。

- **ISSUE-009（Low）登入切註冊分頁會帶走密碼值** — Email 帶過去合理，密碼帶過去容易讓使用者在沒察覺下用一組錯的密碼建帳號。錯誤訊息本身有正確清掉。

### PR #17 明確延後的項目

- **`useRoom` 的 `room` 過期快照本體未修** — `useRoom.ts` 只在 `r.data` 為真時 `setRoom`，`rooms` 查詢失敗會保留舊物件、只亮 `loadError`。離席路徑已改成開 dialog 當場重查、不再讀它，但其他拿 `room.status` 做判斷的地方仍讀得到過期值。目前那些都是伺服器端會驗的寫入（會回明確錯誤而非靜默損壞），風險低但洞還在。若日後有本地端的不可逆判斷要讀 `room.status`，先補 `roomStale` 或改重查。

- **離席 dialog 沒有完整 focus trap** — 已用 `inert` 讓背景不可聚焦／不可觸發，但 Tab 到瀏覽器網址列再回來會落在 dialog 外。完整 top-layer 語意要改用原生 `<dialog showModal>`，代價是重做遮罩與動畫。

- **`room_members` 查詢沒有 `ORDER BY`** — 多房籍時 dialog 的房間顯示順序跟著 PostgREST 回傳順序走（同房的列仍由 `Map` 正確合併，只有多房的排列不保證）。要固定順序加一個 `.order('room_id')`。

- **`leaveConfirmed` 旗標路徑無 E2E** — 單元測試已覆蓋「消耗旗標」與「回到同一筆 entry 不重用」，但沒有真瀏覽器走查（需新增一條「房內按確認→首頁」）。

- **E2E 已在 main 實跑（2026-08-16），殘留兩點** — PR #17 動過 `full-loop.spec.ts` 四處以上（`leaveViaHome` helper、RoomPage dialog 改非同步開啟需等 visible、`inert` 焦點斷言），而 `inert` 只有真瀏覽器有實作。merge（e850ddf）後補跑 `npm --prefix web run e2e`：`雙使用者完整閉環（投票版）`與`房主繼任（lobby 中房主回首頁）`通過，PR #17 動過的四處在真瀏覽器下綠燈。殘留：
  - `全否決擋抽選（嚴格條件房）` 本次未取得有效結果——該案有時段守門（search 回 422 `no_candidates` 就自我 skip：「嚴格條件房在目前時段沒有營業中的平價候選」），執行時段剛好落在守門內。需挑有平價候選的時段補跑一次才算覆蓋。
  - 冷啟動首跑會 flake：`supabase start` 後第一次執行，`waitForRoomRealtime`（`full-loop.spec.ts:9`）的 10 秒逾時撐不過 Realtime 首次訂閱，三條中兩條掛在 Realtime；同一組服務暖機後原樣重跑即通過。修法：拉大該逾時，或在 e2e 前置先打一次暖身訂閱。

- **離席 dialog 的房籍清單在跨分頁競態下會過期**（PR #17 Codex review 2026-08-16，評估後不修）— dialog 開著時另一個分頁建房／加入，清單不會包含新房籍，但按下確認送出的 `/api/leave` 是以執行當下的房籍為準、全退，於是新房被靜默退掉且後果從沒顯示過。修法是「破壞性點擊當下重查，集合有變就要求再確認一次」。
  不修的理由：ADR-0007 Consequences 已裁定「多分頁開首頁會跳出離席確認；個人規模接受，不另做分頁互斥」，這條要求的正是分頁互斥。且它不是本 PR 造成的回歸——改動前是 mount 直接靜默全退、連 dialog 都沒有，現在只是清單可能過期，嚴格來說是變好而非變差。
  若日後改變「個人規模」的假設（多人常態同時開多分頁），連同 ADR 第 24 行一起重新裁定。

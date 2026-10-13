# TODOS 已結案封存

從 `TODOS.md` 移出的已結案項目，原文照搬（含刪除線與結案說明），依原段落分組；2026-10-11 封存。
現行待辦見根目錄 `TODOS.md`。「Final review 遞延」沿用原編號（migration 0003 的註解引用了 `TODOS #5`）。

## P2 eng review 新增（2026-08-06）

- ~~舊房間（>30 天）重開時仍顯示過期的 Google 快取內容~~ 已結案：產品決策（2026-08-10）不支援舊房重開（ADR-0004），不實作重刷或過期標註。

- ~~**dining_history 刪除語意：** `dining_history.room_id` 目前 `on delete cascade`（0003 migration），與 ADR-0002「紀錄跟人」矛盾~~ 已解決：migration 0011 改為 nullable + `on delete set null`（本 commit）。

- ~~**房間清理政策的前置：** 刪房會使 `restaurants_select`（0005）對舊紀錄的巢狀讀取失效（room_candidates cascade 消失）——實作清理時需同步決定 restaurants 的歷史可見性（web 偏好學習與 RecentRatingPrompt 依賴 embed；程式已優雅降級但訊號會靜默流失）。2026-08-11 batch2 final review 發現。Round 2 足跡頁（/history）清單同樣依賴此 embed，波及面擴大為全史最多 500 筆——屆時整頁餐廳名降級為「（餐廳已下架）」。~~ 已結案（2026-08-15）：Round 4 退房制（ADR-0007）以 0022 restaurants_select 的 dining_history 條款解除前置，房刪後歷史 embed 不再降級。

- ~~**restaurants.cuisine_tags 無 jsonb 元素型別 CHECK：** 0001 連 array CHECK 都沒有；D5 的論證同樣適用，但僅 service role 寫入且來源為 Google Places，風險低。下次修改 `restaurants` schema 時順手補。~~ 已結案：migration 0021 已補上元素型別 CHECK。

- ~~**均勻倍率 chip 策略：** timeslot 全場命中、rain 全場飽和、「推薦過但尚未中選」穩態 chip 三案併為一次決策：由引擎 guard 或 web 端過濾（P3 batch 1 final review）。~~ 已結案（2026-10-10）：web 端過濾，`probability.ts` 的 `decisiveFactors` 收起倍率恰為 1 的 chip，以及每家可抽候選的因素、原始倍率、原因完全相同的 chip——比原始值是因為距離是連續值（0.996 印成 ×1.00 仍會拉開機率），原因要一起比是因為快打烊倍率是常數、各家打烊時刻不同；trace 照舊完整寫入、`/search` 回應照舊帶齊。

- ~~**dining_history 排序索引**：足跡頁查詢為 `user_id` 過濾＋`decided_at` 排序，既有 `dining_history_recency (user_id, restaurant_id, decided_at)` 中欄卡住排序用不上；個人規模無感，下次動 `dining_history` schema 時順手補 `(user_id, decided_at desc)`（2026-08-14 Round 2 eng review）。~~ 已結案（2026-08-15）：0022 順手補 `(user_id, decided_at desc)`。

- ~~CUISINE 選項的 Google 缺口~~ 已結案（2026-08-13）：cantonese/hotpot 補真實映射（0018 回填）、sichuan 移除；tags_test gap pin 清空。
  **⚠️ 這個結案是假的（2026-08-16 更正）**：gap pin 只量「app 詞彙 → adapter 產得出來」單一方向，從沒問過反方向「Google 實際回的 type → 有沒有被對映」。`taiwanese_restaurant` 當時就已經漏了（實測 259 家樣本中 64 家帶此 type，40 家撈不到），而測試全綠。修復與雙向紀律見 `docs/superpowers/plans/2026-08-16-cuisine-tag-accuracy.md`。

### Round 3 審查遞延（2026-08-15）

- ~~**連鎖去重早於歇業 tombstone 收集**：`dedupeChains` 在 provider 內先於 `closedIDs` 收集；被連鎖去重丟棄的歇業分店逃過 tombstone，快取可能殘留至多 30 天（TTL 自癒）。~~ 已結案（2026-08-15）：本輪讓 `dedupeChains` 回傳落選歇業分店的 `place_id`，由 handler 併入 `closedIDs` 做 tombstone。

### 菜系打標修復的延後項（2026-08-16 eng review 拆出）

- ~~**`beef_noodle` 沒有生產者，「不吃牛」對牛肉麵店完全失效**~~ 已由 Task 7 Stage B1 結案（2026-08-22）：Google place types 不是食材證據，移除 `no_beef`／`no_pork` 的 UI、推斷與 orphan tags；legacy 值在 app 相容期安全忽略。（仍 blocked 的 Stage B2 留在 `TODOS.md`。）

### ~~limiter map TTL 清理（hosted 前）~~

已結案（7820d26，2026-09-06）：`limiterStore` 每分鐘回收閒置滿一分鐘且額度已回滿的 bucket，並以 `limiterMaxEntries`（10,000）封頂；2026-10-08 查證。原始評估：

- **What:** `server/handlers.go` 的 `limiterStore` per-user map 加 TTL 清理（程式內 ponytail 註解已標「P2 部署時加」）。
- **Why:** 長時間運行的 hosted 部署下，每個曾出現的 user id 永久佔一個 limiter → 緩慢記憶體洩漏。本機/demo 無感。
- **Pros:** 上線前 checklist 自動浮現；修法簡單（last-seen 時間戳 + lazy 清理）。
- **Cons:** 純預防性，當下量測不出差異。
- **Context:** 起點 `server/handlers.go:15-30`；與 Places budget alert 同屬「hosted 上線前」群。
- **Depends on:** hosted 部署計畫（目前無時程）。

## Round 1 final review 遞延（2026-08-13）

- ~~**E2E 地圖渲染守門**：full-loop 補一行 `.leaflet-container` visible 斷言（原斷言在選點器改版時被刪）。~~ 已結清（Round 2 Task 5 捆綁）。
- ~~**mealTimeForE2E 守門加 +60s 緩衝**：`t <= now` 瞬時比較在每日 19:55–20:00 有數秒級 flaky 窗口。~~ 已結清（Round 2 Task 5 捆綁）。
- ~~**mockdata mock-008 的 sichuan 詞彙孤兒**：下次動 mockdata.go 時順手清。~~ 已結案：Round 3 Task 3 移除孤兒 tag，保留 hotpot。

## P2 候選

### ~~Playwright 多客戶端 E2E（完整閉環自動化）~~

已完成（PR #3，2026-08-10）：`web/e2e/full-loop.spec.ts` 走完雙 browser context 的
註冊 → 建房/加入 → 探索檔位 → 條件 → 搜尋 → 投票（贊成/否決/收回/額度/全否決防線）
→ 抽選 → 結果同步 → Maps 導航，執行方式見 `README.md` 的「E2E 測試」。
殘留：尚未接 CI（需編排整套 local stack），與下方「E2E 降級快取情境」合併評估。（2026-10-11 已接 CI：`ci.yml` 的 `e2e` job。）原始評估：

- **What:** 自動化雙瀏覽器完整閉環測試：建房 → 邀請碼加入 → 雙人條件 → 搜尋 → 候選同步 → 抽選 → 結果同步 → Maps 連結。
- **Why:** P1 閉環驗證只有手動 demo script（spec §9 明定 P1 手動）。每次改動手動跑 3 分鐘 × N 次的隱性成本，長期會超過寫一次 E2E 的成本。auth + realtime + 多客戶端同步正是 E2E 決策矩陣建議自動化的類型。
- **Pros:** 回歸保護最強的一層；demo 前可先跑一次確保流程活著。
- **Cons:** Playwright 多 browser context + Supabase local stack 編排，前置設定複雜；CI 上需要起整套 local stack。
- **Context:** 手動流程見 `docs/demo-script.md`；測試重點清單見 `~/.gstack/projects/app/kenne-main-eng-review-test-plan-20260805-201029.md`。起點：Playwright 兩個 `browser.newContext()` 模擬兩位使用者，對 `localhost:5173` 走完 demo script 的九步。
- **Depends on / blocked by:** Phase 1 全部 task 完成後才有意義（2026-08-05 記錄）。

### Final review 遞延（2026-08-06）

- **#1** ~~**join_room 走 PostgREST，不受應用層限流** — Go 的 rate limiter 只護 `/api/*`；join_room 是 RPC 直打 PostgREST，邀請碼有列舉面。要在 DB 層或 gateway 補限流。~~ — 已解決：`join_room` 在 DB 層以 `join_attempts` 限每人每分鐘 10 次（f7d070c），2026-09-20 起 `resolve_room_invite` 共用同一額度（55a7944）；2026-10-08 以本機 DB 查證。
- **#2** ~~**react-router RSC CVE（GHSA-qwww-vcr4-c8h2）為 production dep**~~ — 已解決：升級至 7.18.2，2026-08-09 驗證 `npm audit` clean。
- **#3** ~~**rooms 欄級 grant + 平台預設 TRUNCATE revoke** — 現行 UPDATE grant 比意圖粗（可改 created_at）；anon/authenticated 持有平台預設 TRUNCATE（NOLOGIN + PostgREST 不發，目前不可達）。~~ — 已解決：authenticated 對 `rooms` 只剩 `exploration`、`meal_time`、`cuisine_filter` 三欄 UPDATE，anon/authenticated 在 public schema 沒有任何 TRUNCATE 授權（f7d070c 起）；2026-10-08 以本機 DB 查證。
- **#5** ~~`guard_room_columns` 無 `set search_path`（不可利用，linter 會唸）。（P2 計畫已吸收：Task 2 重寫該函式時順手補，2026-08-06 eng review D5）~~ — 已解決：函式定義已帶 `SET search_path TO 'public'`；2026-10-08 以本機 DB 查證。
- **#16** ~~搜尋鈕無 in-flight guard（可連按）~~ — 已解決：`RoomPage.tsx` 的 `searchInFlight` ref 擋連按（7e322c4），伺服器端另有 per-room single-flight（`TestSearchSingleFlightPerRoom`），E2E 斷言快速連點只送一次 request。
- **#17** ~~首次掛載期的暫時性讀取失敗會閃「找不到房間」頁 — 應三態化（loading / notFound / ok）~~ — 已解決：`useRoom.ts` 回傳 `notFound`，`RoomPage.tsx:53` 僅在 `notFound` 為真時顯示該頁。

### 讀碼發現的舊問題（測試轉換時發現，2026-10-13）

- ~~**HomePage 讀忽略清單沒包 try:** `loadSuggestions` 讀 `prefs-suggest-dismissed:<uid>` 時，storage 被封鎖會丟錯，整個載入變成 unhandled rejection：建議靜默消失，也不顯示「口味建議暫時載入失敗」。「忽略」鈕的 `setItem` 也會在 click handler 裡丟錯。這種瀏覽器連 Supabase 登入都有問題，影響小。~~ 已結案（2026-10-13）：讀寫收進 `lib/dismissed.ts` 並包 try，讀不到當作沒忽略過，寫不進去仍先收起。首頁評分卡的「略過」清單是同一寫法，一起改用。
- ~~**ConditionsForm 按「我準備好了」到條件寫完之間沒鎖滑桿:** `toggleReady` 先 `await flushPending()` 才 `setForm(ready)`，這一個來回期間滑桿還能拖；拖出的那筆排進 400ms debounce，會在 ready 成立後才寫入。~~ 已結案（2026-10-13）：等條件寫完的期間也算凍結；寫入失敗或地點改變時解凍。
- ~~**JoinPage 多房時「取消並回原房」固定回 `rooms[0]`:** `LeaveRoomsBody` 已經每間各給「回到 XXX」，這顆鈕卻替使用者猜回哪一間，和 HistoryPage／HomePage「不替使用者猜」的做法不一致。~~ 已結案（2026-10-13）：這顆鈕只在單房時出現，多房時從各房的「回到 XXX」回去。

### 搜尋進行中房間被刪仍回 500（server 可維護度重構 review 遞延，2026-10-12）

- ~~**What:** 搜尋進行中房間被刪（例如唯一成員的房主在 Places 呼叫期間從另一個分頁退房），仍回 500「資料庫錯誤」。有餐廳時，`freezeSearchCandidates` 的 `assertHostInTx` 回 `ErrRoomNotFound`，它不是 `ErrNotHost`，於是走 `serverError`；零筆時，`rejectChangedSearchSnapshot` 從 `checkSearchSnapshot` 拿到 `pgx.ErrNoRows`。~~ 已結案（2026-10-13）：`checkSearchSnapshot` 讀房間列改用 `roomRowErr`，`freezeSearchCandidates` 與 `rejectChangedSearchSnapshot` 各加 `ErrRoomNotFound` → 404「房間不存在」。`relocation_test.go` 的 `TestHandleSearchRoomDeletedDuringSearchReturns404` 讓 provider 在呼叫期間刪房，零筆、provider 失敗且無快取、有餐廳三條路徑都斷言 404；修正前三條都回 500。

### 封鎖網站資料與加入頁的舊問題（修讀碼問題時 review 發現，2026-10-13）

- ~~**封鎖網站資料的瀏覽器，正式會員建不了房:** `HomePage.tsx` 的 `loadAuthState` 讀 `guest-upgrade:<uid>` 丟錯，被 catch 接成 `authState='error'`，建房鈕換成一顆永遠失敗的「重新檢查」。~~ 已結案（2026-10-13）：讀不到升級標記當作沒有，非匿名就顯示建房鈕。半升級帳號仍由 DB 的 `create_room` 擋下（回「訪客需完成註冊後才能建立房間」）；而且封鎖時 AuthPage 寫標記那一步就會丟錯、升級停在送信前，這台裝置本來也走不到半升級。`HomePage.test.tsx` 的 fail closed 案例拿掉 localStorage 那條，改成「封鎖時會員照樣能建房」與「封鎖時匿名訪客仍只看到註冊入口」。同段其餘三條仍在 `TODOS.md`。

## /qa-only 線上站 QA + PR #17 review 殘留（2026-08-16）

- ~~**ISSUE-002（High）預設條件產生退化結果集** — 全預設（NT$300 上限／800m／步行）在台北 101 搜尋，15 家排除 14 家、全部理由都是「超過 NT$300」，只剩 1 家候選、抽中機率 100%。轉盤只有一個選項等於產品主張不成立，且 App 沒有任何「候選過少、建議放寬條件」的提示就讓使用者走到投票與轉盤。需要產品決策：調預設值、依商圈動態調整、或加候選過少的引導。~~ — 已結案（2026-10-13）：舊版拿每個 Google 價位層級的 NT$ 上限去比預算，只要該層級上限超過 NT$300 就排除；56486ed（2026-08-20）改成先把預算對映成可接受的最高價位層級再比。2026-10-10 在台北 101 用全預設條件、真 API 複測，保留 14 家、排除 4 家，不再重現。「候選過少」的引導沒做，因為退化結果集已經不再出現。

- ~~**ISSUE-005（Low）足跡頁把 3/5 星畫成 3 顆滿星** — `HistoryPage.tsx` 的清單列只渲染 N 顆實心星、沒有空心星做 5 星刻度，3 分讀起來像滿分。摘要區的「平均 3.0 ★」正確，只有列表圖示缺刻度。`icons.tsx` 的 `Star` 已有 `filled` prop（PR #17 加的），補刻度是小改。~~ — 已修（c8d9c57，2026-08-22）：清單列固定畫 5 顆星，未達分數者為空心；2026-10-08 查證。

- ~~**ISSUE-006（Low，間歇）冷啟動首次登入 `dining_history?rating=lte.2` 回 401** — 全新瀏覽器 process 首次登入時觀察到一次（該次首頁 HTML 載入 7489ms），相鄰的同表查詢是 200。像是這支請求在 token 掛上去前就送出的競態；畫面無提示，只有 console 一行 401，影響是「避開不喜歡的菜系」訊號被靜默丟掉。清 localStorage 重登／登出重登／重整各測一次都無法重現。~~ — 已修（2026-10-10）：不是前端競態，token 有掛上。本機重現的 401 body 是 PostgREST 的 `PGRST303 JWT issued at future`：v14.15 閒置後快取時鐘停在舊值，剛簽發的 JWT 被判 iat 超前 30 秒以上（上游 PostgREST#5196，PR #5208 拿掉快取時鐘，v14.18／v16.3 起修正）。本機 Kong log 的 401 全在 PostgREST 閒置之後（6.4 小時、40 秒），且同一秒同 token 的後續請求就回 200；同一刻打到房籍查詢時，新帳號首頁會跳「你還在房間裡」。正式站那次沒抓到 body，推定同因：`supabase link` 寫入的 `supabase/.temp/rest-version`（本機檔、不入版控）是 v14.15。`web/src/lib/supabase.ts` 的 client fetch 遇到這個錯誤會隔 1 秒原樣重送一次。

- ~~**ISSUE-008（Low）邀請碼欄位無長度／格式驗證** — 實際碼是 12 碼，輸入 6 碼仍會送出 `rpc/join_room`。前端可先擋掉省一次往返。~~ — 已修（d217f63，2026-08-22）：邀請碼欄位在 `<form>` 內用原生 `minLength`／`maxLength` 12 與 hex `pattern` 驗證，不足 12 碼不會送出；2026-10-08 查證。

### PR #17 明確延後的項目

- **E2E 已在 main 實跑（2026-08-16），殘留兩點** — PR #17 動過 `full-loop.spec.ts` 四處以上（`leaveViaHome` helper、RoomPage dialog 改非同步開啟需等 visible、`inert` 焦點斷言），而 `inert` 只有真瀏覽器有實作。merge（e850ddf）後補跑 `npm --prefix web run e2e`：`雙使用者完整閉環（投票版）`與`房主繼任（lobby 中房主回首頁）`通過，PR #17 動過的四處在真瀏覽器下綠燈。殘留：
  - `全否決擋抽選（嚴格條件房）` 本次未取得有效結果——該案有時段守門（search 回 422 `no_candidates` 就自我 skip：「嚴格條件房在目前時段沒有營業中的平價候選」），執行時段剛好落在守門內。需挑有平價候選的時段補跑一次才算覆蓋。
  - 冷啟動首跑會 flake：`supabase start` 後第一次執行，`waitForRoomRealtime`（`full-loop.spec.ts:9`）的 10 秒逾時撐不過 Realtime 首次訂閱，三條中兩條掛在 Realtime；同一組服務暖機後原樣重跑即通過。修法：拉大該逾時，或在 e2e 前置先打一次暖身訂閱。

  2026-10-11 結案：嚴格條件房的時段 skip 已在 a1b6fc1（2026-08-20）移除，422 直接 fail，2026-10-11 在 CI 等價 stack 實跑通過；冷啟動 Realtime 改由 CI 的暖身步驟處理，後續觀察移到 `TODOS.md`「E2E 進 CI 後待觀察」。

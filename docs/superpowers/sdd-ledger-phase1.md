# SDD ledger — plan: docs/superpowers/plans/2026-08-05-phase1-demo-loop.md

Branch: feat/phase-1（自 main a0f0238 切出）
User directives: task 間主對話嚴格 review；implementer 可派 codex/sonnet/opus；同一測試修 2 次仍敗 → STOP 回報；每 task commit 後更新 codegraph。
Pre-flight conflict scan: clean（無計畫內矛盾）。
Task 2: minor (deferred): NewVerifier len(secret)<32 拒啟動分支無測試（brief 原始測試亦未涵蓋）
Task 2: minor (deferred): TestAuthMiddleware 未清 SUPABASE_JWKS_URL，外部環境誤設時會誤走 JWKS 路徑
Task 2: complete (commits c77005c..8c7d1f6, review clean)
Task 1: minor (deferred): M1 guard allowlist 的 service_role 是死條目（無任何 grant，fail-closed 但誤導）
Task 1: minor (deferred): M2 guard_room_columns 無 set search_path（不可利用，linter 會唸）
Task 1: minor (deferred): M3 UPDATE grant 比意圖粗（rooms 可改 created_at；建議欄級 grant）
Task 1: minor (deferred): M4 guard 未護 id/created_at（承襲 brief；實務不可達/僅外觀）
Task 1: minor (deferred): M5 handle_new_user 保留預設 EXECUTE TO PUBLIC（returns trigger 不可直呼，僅不一致）
Task 1: minor (deferred): M6 throws_ok 訊息若縮到 5 字元會被當 SQLSTATE 的 pgTAP 陷阱
Task 1: minor (deferred): M7 平台預設 anon/authenticated 持有 TRUNCATE（NOLOGIN+PostgREST 不發，不可達）
Task 1: minor (deferred): M8 migration 非冪等（編號 init migration 屬標準做法）
Task 1: fix round 1/5 (1 addressed, 0 open — I1 grant 矩陣 results_eq pin; commits 0e9bdf0..8fad593)
Task 1: minor (deferred): re-review 觀察 — pin 只盯 grantee='authenticated'，grant to PUBLIC 的放寬不會觸發
Task 1: minor (deferred): re-review 觀察 — 平台預設 ACL 給 authenticated TRUNCATE（同 M7，重複確認）
Task 1: complete (commits 8c7d1f6..8fad593, review clean after round 1)
Note: 兩處實證修正（GRANT block、guard 去 definer）已回寫 plan 文件
Task 3: minor (deferred): MinutesUntilClose 的 -1（未營業）路徑無測試（brief 原測試即缺；手動 trace 正確）
Task 3: minor (deferred): open, close := span[0], span[1] 遮蔽 builtin close（無 channel 使用，無害）
Task 3: complete (commits 8cf6859..6fa1801, review clean)
Task 4: minor (deferred): 測試未釘「具 vegetarian_friendly 應保留」「雙衝突 tag=2 reasons 1 kind」「Kinds 集合內容（僅驗長度）」（codex review）
Task 4: note: brief Interfaces 預覽區塊過時（Kind→Kinds、缺 DisplayName）— 已修 plan 文件（commit 於 463e815 後）
Task 4: complete (commits 6fa1801..463e815, review clean, reviewer=codex)
Task 5: minor (deferred): prefFactor/distFactor 除以 len(Members) 無零守衛（前置 hardExclude 亦 ms[0] 直取 — 全檔既有不變量；handleSearch 會先擋空成員）
Task 5: minor (deferred): TraceEntry 用位置初始化非 keyed fields（verbatim 要求所致）
Task 5: note: 「17 個既有測試」為 controller dispatch 數錯，正確 14=11+3，已對帳
Task 5: complete (commits 111c8d7..94ffc1e, review clean)
Task 6: minor (deferred): report 自審引用行號偏移 ~2 行（純文字誤差）
Task 6: minor (deferred): 未釘「壞 seed 非空清單」與「打亂順序同 winner」回歸測試（手動推演成立）
Task 6: minor (deferred): append clone 可用 slices.Clone（風格，不動已驗證碼）
Task 6: complete (commits 94ffc1e..a39b02c, review clean)
User directive (2026-08-06): implementer 一律 Opus 或 Codex，Sonnet 不寫程式；Task 7 in-flight sonnet 例外跑完（Codex 嚴審），fix rounds 起改 Opus；Task 8+ 全面切換。
Task 7: review (codex): Needs fixes — 3 Important（db error 繁中違反、excluded nil→null、loadHostRoom 全錯誤當 404）；1 Minor（並發 draw 測試）deferred
Task 7: minor (deferred): 並發 draw 的 23505/transition conflict 無實測（僅狀態前置檢查覆蓋）
Task 7: note: 「db error」為 plan 自帶碼與自身 Global Constraints 衝突 — 依約束修繁中（與 eng-review 判例一致），未另問
Task 7: fix round 1/5 dispatched（Opus，per user directive）
Task 7: fix round 1/5 (3 addressed 待 re-review — db error 繁中/[] init/honest 404; commits ae3e3ad..2dbce2f)
Task 7: controller-confirmed gaps → round 2：integration cleanup ordering（pool.Close 先於 t.Cleanup delete，不可重跑）+ gofmt 漂移（engine_test.go/weights.go）
Task 7: minor (deferred): []/null 契約無測試斷言（現測試 excluded/kept 皆非空）
Task 7: fix round 2/5 (2 addressed — cleanup ordering 連跑三次實證 + gofmt; commits 2dbce2f..498d37b)
Task 7: re-review: 5/5 ADDRESSED, no new breakage
Task 7: minor (deferred): keptJSON.Trace 的 nil-ability 依賴 engine.Evaluate（本 diff 外）；rtk 包裝的測試計數粒度與手數不同（非回歸）
Task 7: complete (commits a39b02c..498d37b, review clean after 2 rounds, reviewer=codex, fixer=opus)
Task 8: minor (deferred): create-vite 樣板殘留（App.css/assets/README/oxlintrc 等，無 import 純噪音）
Task 8: minor (deferred): 數檔無結尾換行（cosmetic）
Task 8: minor (deferred): npm audit 2 high（scaffold 傳遞依賴；未 --force，final review 統一裁）
Task 8: complete (commits 498d37b..9d62f04, review clean, implementer=codex)
Task 9: review: Approved + 1 Important（createRoom 缺 try/finally，busy 永久卡死邊界）→ fix round 1
Task 9: minor (deferred): create/join 錯誤訊息不對稱（create 透傳 raw message）；join 表單無 busy 的 nav race（低機率無污染）；輸入框無 label 僅 placeholder（沿用既有風格）
Task 9: fix round 1/5 (1 addressed — try/finally busy guard; commits db54c4d..bf7bc9d)
Task 9: re-review: ADDRESSED, no new breakage（no-catch 取捨維持，措辭修正：保留的是開發者 console 訊號）
Task 9: complete (commits b640e03..bf7bc9d, review clean after 1 round, implementer=opus)
Task 10: review (opus): Needs fixes — 1 Critical（RLS 凍結 204 無 error → 靜默成功死碼）+ 3 Important（stale CLOSED 蓋 SUBSCRIBED、搜尋無 .catch、房間讀不到無限載入）
Task 10: minor (deferred): unmount 未清 debounce timer；notReady 含房主自己；搜尋鈕無 in-flight guard；422 body 防禦不足（非 JSON/excluded_by 缺席）；同批次 save 可吞 patch（實務安全）；dynamic import 無收益
Task 10: fix round 1/5 dispatched（fresh Opus — codex 不可 resume）
Task 10: fix round 1/5 (4 addressed — count:'exact' 凍結偵測、live 旗標、.catch、notFound; commits e1509a8..eb5dae6)
Task 10: re-review: 4/4 ADDRESSED, no new breakage
Task 10: minor (deferred): 首次掛載期的暫時性讀取失敗會閃「找不到房間」頁（自癒、優於修前的無限轉圈）
Task 10: complete (commits 689e394..eb5dae6, review clean after 1 round, implementer=codex, fixer=opus)
Task 11: minor (deferred): chips 用 index key（後端一次性陣列，可接受）；sortExcluded 不排序（依 DB 回傳序）；formatPercent p=0/p=0.01 邊界無測試（邏輯推導正確）
Task 11: complete (commits 377b450..2cb7207, review clean, implementer=opus)
Task 12: review (opus): Needs fixes — 1 Critical（hooks 在 early return 後，進房必 crash；gate 缺 lint 所以三綠照過）+ 1 Important（單候選 360° 弧退化空白轉盤，實測證實）
Task 12: minor (deferred): Wheel !s 分支 dead-end（實務不可達）；maps.ts 行內 union 可用 MemberRow['transport']；機率總和<1 留楔形缺口（server 正規化保證）；candidates 查詢無 ORDER BY（既有）
Task 12: process: 驗收 gate 自此含 npm run lint（0 errors）；Task 13 全套驗證同步納入
Task 12: fix round 1/5 dispatched（Opus）
Task 12: fix round 1/5 (2 addressed — hooks 前移+spinning 刪除、arcPath 359.99 夾擠含 flag 一致; commits 5180342..406fae7)
Task 12: re-review: 2/2 ADDRESSED, no new breakage（順帶消除一楨 ResultCard 閃現）
Task 12: complete (commits 2cb7207..406fae7, review clean after 1 round, implementer=codex, fixer=opus)
Task 13: controller E2E（瀏覽器實測）：註冊×2、定位 fallback、建房 643D0C、邀請碼加入、雙向 realtime ready 同步、非房主無搜尋鈕、搜尋→候選（復興清粥小菜 100%）、chips 三因素、排除 10 家全帶成員歸因與多重原因（老四川 3 條「；」串接）、轉盤→ResultCard、Maps href 純座標+walking、draws seed+快照Σ=1.0000 — 全數通過
Task 13: E2E finding → fix round 1：README 本地指引用 JWT_SECRET 會 401 — 新版 CLI 發 ES256，需 SUPABASE_JWKS_URL（D4 保留 JWKS 雙路徑的決策救了 demo）
Task 13: fix round 1/5 (1 addressed — README JWKS 指引; commits e135965..983d003)
Task 13: controller-confirmed (cosmetic, → final fix wave): server/auth.go:20-21 註解「local = HS256」已過時（CLI 2.111 local 亦 ES256）
Task 13: review: Approved（docs verbatim + 指令/UI 字串全對照實碼）；1 Minor（auth.go:20-21 過時註解）→ final fix wave
Task 13: complete (commits 789fece..983d003, review clean after 1 round, implementer=opus)
=== ALL 13 TASKS COMPLETE — final whole-branch review ===
Final review (opus): With fixes — 0 Critical；3 BLOCK-MERGE（I1 undefined alert、I2 README JWKS vs 測試環境、I3 local=HS256 殘留×4）+ 5 FIX-NOW-CHEAP；ledger 33 條裁決：16 DEFER-P2、17 DROP
Final review 流程建議（採納）：fix round 的 deviation 必須回寫 plan — 記入 memory
Final fix wave dispatched（Opus，9+1 項單一波）
Final fix wave: 10/10 addressed (commits 983d003..2aaf802; M3 落 go 1.25.0、TODOS 18 條均 ADDRESSED-WITH-DELTA 可接受)
Final re-review: clean — READY TO MERGE
=== PLAN COMPLETE: 13 tasks, 6 fix rounds, 0 open findings ===

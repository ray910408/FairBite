# 房間決策與訪客：執行紀錄

規格：`feature-interview-2026-09-17.md`。使用者於 2026-09-17 授權實作、子代理及每個 task 審查後獨立 commit；未授權 push 或部署。

分支：`codex/room-decisions-guests`，起點 `f663ea1`。起始變更僅本次訪談文件，先納入規格基準提交，功能 task 從乾淨狀態開始。

## Task 與驗收門檻

| Task | 範圍 | 實作者 | 審查與驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 0 | 已核准規格、ADR、執行紀錄 | 主代理 | 逐項核對使用者決策、diff/UTF-8 檢查 | 已審查並獨立提交，見下列紀錄 |
| 1 | 待確認抽選、版本、重轉與耗盡回準備；後端/schema/UI | Sol | 主代理檢查交易/授權/歷史/重算；Go、DB 整合、Vitest、build | 已審查並獨立提交，見下列紀錄 |
| 2 | 改地點表決、離房門檻、選點與搜尋競態；後端/schema/UI | Sol | 主代理檢查鎖序與舊搜尋失效；Go、DB 併發、Vitest、build | 已審查並獨立提交，見下列紀錄 |
| 3 | 訪客身分、QR 邀請、升級新帳號與切換既有帳號 | Sol、主代理 | 主代理檢查 Auth/RPC/RLS/email 驗證；DB/Auth 整合、Vitest、Playwright | 已審查並獨立提交，見下列紀錄 |
| 4 | 僅保留 Google 候選的 Maps 店家連結 | Luna | 主代理檢查連結/來源/排除判定；Vitest、build | 已提交 `fb652ab` |
| 5 | 全流程整合、部署文件與驗收核對 | 主代理、Sol 文件 | Go/web/DB/E2E；核對四項需求與既有契約 | 已審查與驗收，納入 Task5 提交 |

獨立 task 可並行實作，但每項需完成主代理審查、修正與必要測試才可 commit；每個 commit 後執行 `codegraph.cmd sync D:\app` 並核對狀態。未通過審查不得視為完成。每個 task 提交前將證據寫入本檔。

## 停損與測試紀錄

- 同一測試修復最多兩輪；兩輪後仍失敗立即停止並回報命令、失敗輸出、已嘗試修正，禁止第三輪修復。
- 本機工具無回應或超時依使用者規則停止並回報；有有效 session handle 的背景工作可正常等待。
- 起始 Docker 查詢回覆找不到 `docker_engine` pipe；尚未取得可用測試 DB，不能把跳過的 DB 測試記成通過。
- 起始 `supabase.cmd status` 因沙箱無權寫入使用者目錄下 telemetry 暫存檔失敗；不是應用測試失敗。
- 功能部署與正式 Supabase 設定不在本次自動操作範圍；文件必須標示部署要求與本機未驗證項目。

## 審查證據

Task 0：主代理核對 17 項訪談決策與四項原始功能，ADR-0008/0009 改為 accepted，保留「尚未實作」的功能界線；文件 diff 檢查通過。


Task 4（2026-09-18）：Luna 實作，主代理獨立核對 CandidateList 僅在 kept 清單依 source 顯示店家連結、excluded/mock 無連結、URLSearchParams 編碼與 fallback、target/rel、原導航函式未改。主代理執行 npm test -- src/lib/maps.test.ts src/components/PrivateScoring.test.tsx：2 files / 11 tests passed；npm run build exit 0；npm run lint exit 0（既有 warnings）。未有測試修復輪次。

驗證環境（2026-09-18）：已啟動獨立 app_features Supabase，ports 55321/55322/55324，baseline a57ae8a migrations 全部成功。原 app 的 47 個房間未重設。規格 commit a57ae8a 後 CodeGraph sync 回覆 Already up to date。

Task 2 初步證據：主代理實作改地點交易與 search_version trigger，Luna 實作独立 RelocationPanel。TestLocation* 真實 DB 測試通過（2026-09-18，最新 0.523s），涵蓋 4 人嚴格過半、撤回、通過後鎖定、成員授權、選點重設、相同座標輪次失效及與真實 draw handler 的競態。relocation_test.sql 的 8 項 pgTAP 全通過。尚未整合 routes/useRoom/RoomPage/leave/freeze，不能視為功能完成；未有失敗修復輪次。

Task 1：主代理審查後補強欄位 grants、版本一致性、轉盤採不可變機率快照並按版本 remount；核對 pending 不寫歷史、host-only confirm/redraw、版本鎖、批次排除、候選耗盡及房主繼任。主代理提交前證據：TestPending* 真實 DB passed（0.733s）、6 files / 89 web tests passed、pending_selection_test.sql 6/6 passed。Sol full server DB passed（9.628s）；最後含搜尋的歷史測試重跑碰到隔離庫累計配額429，此前全套通過，待最終整合環境再驗。全 web/build 當時受並行 Task3 未完成檔案影響，不宣稱全樹已通過。硬失效測試一次修正 fixture 後通過，未超過兩輪。

Task 2：Sol 整合 routes、leave、freeze、Realtime 與 RoomPage；主代理審查鎖序、版本與座標比對、退房後多數計算、UI 權限與設定 flush，並把選用換地點從固定必經步驟移除。主代理 TestLocation*/TestFreeze* 真實 DB passed（0.701s），web 4 files / 36 tests passed；補上實際 handleSearch 阻塞期間同座標新輪次的回歸，確認舊搜尋 409、仍為 lobby、無舊候選。Sol full server DB passed（10.471s）、web 327/327 passed、build passed、pgTAP 8/8 passed。沒有同一測試超過兩次修復。

## 2026-09-19 停損點（等待使用者決定）

- 已提交 Task1 `5e3ffc7`、Task2 `a206b60`、Task4 `fb652ab`；每次提交後 CodeGraph sync 成功。
- `TestGuestAuthLiveIntegration` 第一次失敗為 fixture 的 host_id text/uuid 不符，修正 `$1::uuid`；第二次失敗為 fixture 缺 restaurants.source，補 `source='mock'`；第三次在真實 `/api/auth/validate-upgrade-email` 收到 `503 upgrade_validation_unavailable`。依同一測試兩次修復上限，未進行第三輪修復或再測。使用隔離 Supabase 55321、DB 55322、Mailpit 55324、API 8788，未改正式環境。
- 真實匿名建立與未經驗證直接 updateUser 被拒已有證據；Email 驗證、密碼完成、同 UID 紀錄延續及建新房後段尚未通過。資料庫只讀日誌尚未確認 503 根因，另見測試清理順序造成 restaurant/history 外鍵錯誤，待後續處理。
- 父代理雙使用者完整閉環已通過（48.8s），包含 pending→confirm→history/rating。初次 Realtime timeout 改為從實際建房前計時，一次修復後通過。
- 新 QR 三瀏覽器測試首跑停在 async controlled checkbox 的即時 check 斷言，尚未修正與重跑。新 E2E 的 clipboard 型別需修；HomePage 最新 getUser 呼叫仍需補齊既有測試 mock。最新全樹不可宣稱 tests/build 通過。
- Task3 與整合驗收仍未提交；目前修改保留，未 push 或部署。

### 使用者授權額外一輪後（2026-09-19 10:23）

- 使用者明確允許額外一輪。父代理與 Sol 只讀核對確認 503 根因是 `postgresGuestAuthStore.SaveValidation` 的 `QueryRow` 漏傳 `uid,email`；已補上參數。另修正 live test 的 Mailpit JSON 解碼與 fixture 清理順序。
- 修正後重新編譯並重啟隔離 API，執行 `go test -run '^TestGuestAuthLiveIntegration$' -count=1 -v`。503 不再發生；測試走到最後 `create_room`，回 400／P0001「訪客需完成註冊後才能建立房間」，仍失敗（0.483s）。額外一輪已用完，未再修復或重跑；Email 確認狀態與匿名升級完成條件仍待診斷，不能宣稱訪客升級全流程通過。
- 最新 `npm test` 33 files / 328 tests passed；`npm run build` exit 0（既有 bundle warnings）。已補 HomePage getUser mock、E2E clipboard 型別；QR controlled checkbox 改 click 後等待伺服器同步斷言，但尚未重跑 QR E2E。
- 目前再度停損，等待使用者下一步決定。Task3 與 Task5 仍未提交。

### 定位並修復 Auth 更新順序（2026-09-19）

使用者先授權只讀診斷，再明確授權「修正並驗收一次」。隔離 Auth 實際版本為 v2.194.0；其 verify.go 先單獨更新 is_anonymous=false，再由 ConfirmEmailChange 更新 email。原 trigger 只檢查 old.is_anonymous，因而漏將 pending_confirmation 轉為 confirmed。修正為仍有 pending_confirmation 票據時繼續核对精確 UID／Email，保留完成註冊前禁止建房的限制。

父代理證據：guest_identity_test.sql 9/9 passed，新增兩步更新、匿名旗標清除後錯誤 Email 仍被拒、確認但無密碼仍被拒、完整帳號可建房；核准的一次 TestGuestAuthLiveIntegration passed（0.565s），完整驗證匿名建立、直接 email 更新被拒、API 驗證、收信確認、設定密碼、同 UID 房籍與歷史保留、升級後建新房。尚未將 hosted 設定或部署視為已驗證。

QR 三瀏覽器 E2E 第一輪修復 async checkbox 斷言後，發現實際 UI 問題：relocating 時 ConditionsForm 已卸載、flush 回 false，使確認新地點不送出。第二輪修正僅在 lobby 等待條件儲存，保留 lobby 閘門；RoomPage 40/40 tests passed，QR E2E 正在執行第二輪修復後驗收，若再失敗即停損。

Task3 提交前主代理審查結論：核對 signed anonymous hook、Regex+MX 升級票據、Auth 分兩步更新順序、RLS/RPC 建房閘門、原 UID 延續、既有登入必須明示退房、兩個確認框的 inert 背景、QR 加入與 lobby 限制、定案後提示及同瀏覽器跳過記憶。QR 三瀏覽器第二輪修復後通過（38.9s），涵蓋暱稱加入、改地點、訪客接任房主、重新準備、排除重轉、不寫被排除店歷史、正式提示、跳過後重新入房、訪客首頁無建房按鈕。最新 full server 真實 DB passed（10.100s）；full web 33 files / 329 tests passed；production build 與 lint exit 0（bundle、Fast Refresh 和既有 hooks 等非阻斷 warnings）。Auth live 與 pgTAP 證據如上；HTTP signup hook 尚未在本機 Auth stack 啟用，正式部署需另行驗證。全部 E2E 回歸納入 Task5 最終驗收。

Task3 已提交 `85bc857`，CodeGraph sync 成功（Already up to date）。Task5 全部 7 項 Playwright E2E 通過（2.0m），包含邀請輸入限制、慢搜尋／離席、雙使用者正式定案閉環、QR 三瀏覽器閉環、全否決與房主繼任。

## 需求與驗收證據對照

| 核准需求 | 實作與證據 |
| --- | --- |
| 改搜尋中心、嚴格過半、撤回、離房重算、通過不可撤销、繼任選點 | `relocation.go` 與 `TestLocation*` 真實 DB；QR E2E 驗證雙投票並行、過半暫停與訪客繼任；`TestHandleSearchRejectsSameCenterNewRound` 證明舊搜尋不覆蓋新輪次。 |
| 房主確認／排除重轉、批次排除、耗盡回準備、只有正式結果入歷史 | `pending.go`、`TestPending*` 與 pending pgTAP 6/6；雙使用者與 QR E2E 實際驗證 pending 按鈕、重新轉動同步、只保留確認店的歷史。 |
| QR 暱稱入房、同瀏覽器恢復、訪客繼任、建房需完成註冊 | `JoinPage`、`resolve_room_invite`／既有 `join_room` 與 `create_room` 授權；guest pgTAP 9/9、live Auth、QR E2E；加入者未取得定位權限仍可完整參與。 |
| 定案後可跳過註冊提示、原 UID 升級、既有帳號不合併 | Prompt 測試與 QR 重入房驗證；live Auth 檢查同 UID 房籍／歷史；AuthPage 離席確認、失敗返回與直接登入守門由程式審查及回歸測試覆蓋，沒有跨 UID 資料合併路徑。 |
| 保留候選 Google Maps 店家連結、排除與 mock 無連結 | `maps.test.ts`／`PrivateScoring.test.tsx`；既有結果導航不带 origin，URL 正確編碼並保留新分頁語意。 |

部署仍不在本次執行範圍。正式 Supabase 設定、HTTP signup hook 與公開 QR 網址的裝置掃碼需按 `deploy.md` 在部署時驗證；本機 Maps 使用 mock，真實 Google 店家連結以 URL/來源單元測試驗證。上述界線不代表已部署、已 push 或真實 Google API 已連線。

## 最終審查與提交

Task0 `a57ae8a`、Task1 `5e3ffc7`、Task2 `a206b60`、Task3 `85bc857`、Task4 `fb652ab` 均已独立提交並同步 CodeGraph。Auth 後續審查發現初始 getUser 尚未完成時快速提交可錯分訪客身分；`4827013` 改為提交時讀取 session，兩個回歸涵蓋登入退房確認與同 UID 註冊升級。主代理重新執行 AuthPage 53/53 passed；Sol build passed；提交後 CodeGraph sync 成功。

Task5 完成部署文件、ADR／CONTEXT、一致的本地 Email confirmation 測試前置，以及 7 項 E2E 回歸。全套 E2E、329 項前端測試與 Go／DB 結果取得於 Auth 快速提交修正前；該修正另以 AuthPage 53 項及 build 驗證，未將未重跑的全套結果視為新修正後的結果。最終 diff 檢查與需求對照完成，無待實作功能；未 push 或部署。

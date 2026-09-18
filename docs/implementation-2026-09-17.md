# 房間決策與訪客：執行紀錄

規格：`feature-interview-2026-09-17.md`。使用者於 2026-09-17 授權實作、子代理及每個 task 審查後獨立 commit；未授權 push 或部署。

分支：`codex/room-decisions-guests`，起點 `f663ea1`。起始變更僅本次訪談文件，先納入規格基準提交，功能 task 從乾淨狀態開始。

## Task 與驗收門檻

| Task | 範圍 | 實作者 | 審查與驗證 | 狀態 |
| --- | --- | --- | --- | --- |
| 0 | 已核准規格、ADR、執行紀錄 | 主代理 | 逐項核對使用者決策、diff/UTF-8 檢查 | 已審查，納入本次提交 |
| 1 | 待確認抽選、版本、重轉與耗盡回準備；後端/schema/UI | Sol | 主代理檢查交易/授權/歷史/重算；Go、DB 整合、Vitest、build | 已審查，納入本次提交 |
| 2 | 改地點表決、離房門檻、選點與搜尋競態；後端/schema/UI | Sol | 主代理檢查鎖序與舊搜尋失效；Go、DB 併發、Vitest、build | 核心與面板完成，待整合 |
| 3 | 訪客身分、QR 邀請、升級新帳號與切換既有帳號 | Sol | 主代理檢查 Auth/RPC/RLS/email 驗證；DB/Auth 整合、Vitest、Playwright | 實作與 Auth 驗證中 |
| 4 | 僅保留 Google 候選的 Maps 店家連結 | Luna | 主代理檢查連結/來源/排除判定；Vitest、build | 已審查並通過測試，納入本次提交 |
| 5 | 全流程整合、部署文件與驗收核對 | 主代理 | Go/web/DB/E2E；核對四項需求與既有契約 | 待執行 |

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

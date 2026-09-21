# PR #22 修復與驗證（2026-09-20）

基準：`a81863e`；PR https://github.com/ray910408/FairBite/pull/22。
依使用者要求逐項審查、獨立提交並更新 CodeGraph。未授權 push、merge 或部署。

## DB CI

- GitHub run `35449602122` 的 `db` job：pgTAP `rls_test.sql` 第 1、18 項失敗。
- 核對 migrations 後，expected matrix 缺少合法的 `location_change_votes SELECT` 與 rooms 的 `draw_version/search_version SELECT`。
- 僅補完整精確集合；保留禁止寫入、非成員隔離及座標隱私斷言。
- 主代理於隔離 `app_features` 執行 `supabase test db supabase/tests/rls_test.sql`：61/61 通過。

## Web CI 與加入前離席（review 4053498317）

- 同 run 的 web job：JoinPage unit test 在 import 時啟動真實 Supabase client，缺少 CI 環境設定而失敗。
- 測試明確 mock 外部 client；不依賴開發機 `.env`，也不在 production 加假設定。
- `leaveRooms` 保留 5 秒 timeout 及 single-flight，HTTP/網路/逾時錯誤改傳給呼叫端；首頁明確保留 best-effort。
- 加入流程離席失敗時保持 dialog，不繼續 resolve/join；錯誤呈現在有效 dialog 內。

## 待確認結果同步（review 4053498315）

- confirm/redraw 成功後等待權威 `refetch`，完成前保持 busy，避免 Realtime 中斷時繼續送出舊版本。
- API 失敗不 refetch；成功但重新載入失敗則告知重新整理，不把已成功的動作說成失敗。
- 主代理與 Sol 分別驗證 RoomPage：46/46 通過，含延遲 reload、錯誤與重複點擊保護。

## 訪客升級（reviews 4053498309、4053498312）

- 只有目前 Email 已確認且符合本 UID 升級標記時，才顯示／允許完成密碼設定；提交時再次核對 session。
- 未完成升級可以更正 Email，維持相同 UID；登入既有帳號仍須先確認離席。
- DB 同一 SQL 鎖定 Auth user 後核對升級資格並存票據；同 Email 重送維持 pending，改 Email 重置驗證，confirmed／正式帳號被拒。
- 新 migration `20260920000100_guest_upgrade_email_correction.sql` 讓已清除匿名旗標的 validated／pending 票據繼續受 trigger 保護。
- 主代理確認：AuthPage 60/60；實際 DB store regression；pgTAP；真實 Auth 更正 Email、收信驗證、密碼設定、原 UID 房籍／歷史保留及建房全部通過。

## 額外驗收修復與最終證據

- 完整 pgTAP 在保留資料的隔離庫發現 relocation 測試將其他房間 2 張投票也計入；斷言改限定測試房間，沒有刪除既有資料。此測試一次修正後通過。
- 最新前端 `npm test`：33 files／352 tests passed；刻意清空 Supabase URL/key，驗證不依赖開發設定。production build exit 0；lint exit 0，既有 11 warnings 與 bundle warnings 未列為修復範圍。
- 完整 `go test ./... -count=1` 搭配隔離 `TEST_DATABASE_URL`：PASS（9.922s）；`go vet ./...` exit 0。
- 完整 `supabase test db`：7 files／143 assertions passed。
- `TestGuestAuthLiveIntegration`：PASS（1.67s），使用隔離 API 8788／Auth 55321／DB 55322／Mailpit 55324。
- 本輪未重跑 Playwright 或 race；沒有把先前 E2E、GitHub 舊 CI 結果當成本輪修正後的證據。
- API 啟動曾被審批額度阻擋；14:54 額度重設後重新經正常審批啟動並完成驗收，未繞過審批。

已提交 task：DB CI `a6e3589`、pending 同步 `5fef58a`、web CI／離席錯誤 `99ed028`、Auth `8fafe96`；每次提交後 CodeGraph sync 成功。
此文件與測試隔離修復經上述驗收後另行提交。GitHub review threads 尚未標記 resolved；未 push、未 merge、未部署。

## 後續 review：帳號切換錯誤（4056390773）

- 核實成立：確認視窗開啟時主表單為 inert，原本只在主表單顯示錯誤，視窗內沒有回饋。
- 將錯誤 alert 放在有效視窗內；主表單避免重複顯示。取消視窗後仍可在表單看見錯誤。
- 新增離席 HTTP／network 與登入 credentials／network 四個回歸；修改前四項均因視窗缺少錯誤而失敗，修改後 AuthPage 64/64 passed。
- Sol 獨立審查通過；主代理核對失敗不導頁、離席失敗不嘗試登入、busy 結束後可重試。
- 同批前端驗證：33 files／359 tests passed（清空 Supabase URL/key）；production build exit 0。

## 後續 review：首頁未完成升級訪客（4056390771）

- 核實成立：GoTrue 匿名旗標清除後，仍可能等待 Email 驗證或密碼設定；AuthPage 的 UID 升級標記直到密碼成功設定才移除。
- HomePage 沿用既有註冊入口，把具有目前 UID 升級標記的使用者歸入訪客，避免提前顯示建房操作。
- 主代理審查 Sol 修復，核對標記的建立／移除路徑；未放寬 DB 建房資格。
- 三個新增回歸涵蓋匿名、非匿名但升級待完成、無升級標記的一般會員；同時核對註冊連結及建房按鈕。HomePage 42/42、完整前端 359/359 passed。
- 帳號切換 task 已提交 `efe9366`，提交後 CodeGraph sync 成功。

## 後續 review：搜尋提前返回的地點快照（4056390769）

- 核實成立：零筆 422 與 provider failure／cache miss 502 會早於原本 freeze 的 search snapshot 驗證返回。
- 兩個提前返回點現在直接重讀 search_version／中心；漂移回 409，查詢失敗回 500。正常候選流程仍在 room lock 內重驗，沒有新增 Places 呼叫。
- 主代理審查後加強 DB regression：測試位置遠離既有餐廳且先明確斷言沒有快取，避免誤測正常 freeze 路徑。
- 六案例涵蓋空結果／provider failure 各自的未變動、換地點、新輪次但同中心；驗證 422／502／409 正確且房間保留 lobby、沒有候選。
- 用 Go overlay 載入修正前 handler：兩項未變動對照通過，四項漂移案例分別錯回 422／502 而失敗。工作樹修正版六項全部通過。
- 隔離 DB 55322 的完整 `go test ./... -count=1` PASS（10.708s），`go vet ./...` exit 0；前端 lint／TypeScript exit 0（既有 11 lint warnings）。本輪未重跑 Playwright 或 race。
- 子代理最初誤用既有 DB 54322 執行 fixture 測試，pre-provider 500／既有測試等待 provider 逾時；其 cleanup 會刪除該測試生成的 UUID 房間／使用者，但未查詢驗證清理後筆數。沒有 reset、migration 或快取刪除。上述正式驗收全數改用既有 app_features 隔離環境，沒有採用 54322 結果。
- 首頁 task 已提交 `6d9d4d4`，提交後 CodeGraph sync 成功。前三節歷史狀態以當時記錄為準；`c985106` 已 push，GitHub web/server/db 三項 CI 通過；本次三個 review 修復另行推送並逐項結案。

## 後續 review：首頁身分查詢失敗（4057058221）

- 核實成立：原本初始值與 catch 都是 `isGuest=false`，查詢尚未完成、Auth 拒絕或 localStorage 讀取失敗時，都會顯示建房操作。
- 改用 checking／guest／member／error；只有查詢成功且不是訪客或未完成升級時顯示建房。錯誤就地顯示並提供重新檢查；既有 DB 建房資格不變。
- Sol 實作後由主代理審查：核對匿名、升級標記、正式會員、returned error、rejection、缺少 user、storage exception 與 retry。測試使用真正 initial state，避免 mock 預先指定 checking 而漏掉初始狀態回歸。
- 修正前 auth boundary 測試 7 項失敗；修正後首頁 48 tests、完整前端 33 files／365 tests passed（清空 Supabase URL/key）。Sol 執行 build／lint exit 0，既有 warnings 未更動。

## 後續 review：邀請查詢繞過限流（4057058225）

- 核實成立：原本 SECURITY DEFINER resolver 可反覆確認邀請碼，完全沒有使用 join_room 的邀請嘗試計數。
- 新增 migration `20260920000200_invite_resolution_throttle.sql`；resolver 改為 VOLATILE PL/pgSQL，先取得與 join_room 相同的 UID advisory transaction lock，再使用同一 join_attempts／每分鐘 10 次額度。
- 有效、無效、非成員看不到的已開始房间都先計數；查無結果正常回傳空集合，避免 raise 回滾嘗試。保留 RPC 結構、既有成員回房與 grants，不寫房籍。查詢後加入使用 2 次額度，部署文件已說明。
- JoinPage 的 resolver／join 限流錯誤改顯示「嘗試過於頻繁，請稍後再試」，避免誤報房間不存在。兩項回歸修正前失敗、修正後 JoinPage 8/8 passed。
- pgTAP 修正前 7/17 failed，隔離 app_features（55322）套用新 migration 後 17/17 passed；完整 SQL 8 files／160 assertions passed，測試均 rollback，沒有操作原 DB 54322 或 production。
- 主代理與 Sol 只讀審查核對相同 lock key、共享額度、正常返回的計數持久性、權限與呼叫端。雙 session contention 未執行；並發序列化依據為兩個 RPC 的同一 transaction advisory lock。
- 最終前端 33 files／367 tests passed；build／TypeScript／lint exit 0（既有 11 warnings）。本輪未執行 Go、Playwright 或 race；修改範圍為 Web 與 SQL。
- 首頁 task 已獨立提交 `3a135b5`，CodeGraph sync 成功。限流 task 驗收後獨立提交；兩則留言於 push 後回覆並讀回 resolved 狀態。

## 後續 review：QR 入房預設偏好（4057141111）

- 核實成立：QR 成功加入後原本直接導頁，跳過首頁已有的預設 cuisines 帶入。
- 將既有 applyDefaultPrefs 原樣移至共用 lib/defaultPrefs.ts；首頁與 QR 新入房共用，既有成員回房不重套偏好。
- 新回歸於修正前 1/10 failed，修正後 JoinPage／HomePage 58 tests passed；驗證有效 cuisine 篩選、只填空條件列、await 寫入後導頁與既有房籍不重套。
- Sol 獨立只讀審查無 blocker，build／TypeScript exit 0；本項沒有執行瀏覽器或 live RLS 驗證。

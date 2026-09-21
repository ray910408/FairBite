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

## 後續 review：升級回應遺失的恢復標記（4057141108）

- 核實成立：Auth 已提交 Email 更新，但回應遺失或關頁時，原本尚未寫入本機 UID marker，重載便無法恢復升級。
- 通過既有 Email 驗證後，先持久化目標 Email，再呼叫 updateUser；回應失敗保留 intent，下次可恢復或更正，storage 寫入失敗則不開始 Auth 更新。
- Sol 實作、主代理逐項審查；新增回應遺失 regression 修正前失敗，修正後 AuthPage 66/66 passed，另覆蓋 storage exception 不更新 Auth。既有重載測試核對非匿名 pending／已驗證相符 Email，以及同 UID 更正 Email。
- 這是同瀏覽器的既有恢復契約；未新增跨裝置恢復，也未宣稱 live Auth 實測。

## 後續 review：候選恢復後轉盤卡住（4057141109）

- 核實成立：Wheel 在 winner row 缺少時提前返回，原 effect 僅監看 winnerId，補回候選也不會完成動畫。
- effect 加入 winnerPresent；缺少到出現時重新啟動，一般候選 refetch 不重設 timer。
- Sol 實作、主代理審查；修改前 recovery 的 onDone 0 次而失敗，修正後 recovery 與不中斷 timer 兩項通過。hook mock 在 deps 改变與測試結束執行 cleanup。
- 完整前端 34 files／379 tests passed（含既有 RoomPage pending controls 測試）；build／TypeScript 通過。回歸直接驗證 Wheel onDone，沒有宣稱瀏覽器重試的端到端實測。

## 後續 review：過期邀請非同步工作（4057141115）

- 核實成立：effect 的 active 原本只保護 getSession，晚到 resolver／房籍查詢仍可加入舊房並導頁。
- 以 route generation 貫穿 resolver、房籍檢查、join、偏好與導頁；cleanup 失效化舊 generation，路由改變重設畫面狀態，錯誤與 finally 也只更新目前頁面。
- 訪客登入、確認離席及 retry 沿用同一防護。已送出的後端 mutation 無法由此撤銷；保證失效後不再啟動後续入房、不套用晚到結果或導頁。
- 四項回歸於修改前失敗（resolver／房籍／join 晚到及換碼），修正後通過；另補 guest sign-in／leave 晚到兩項。JoinPage 16/16 passed。
- 主代理實作、Sol 獨立只讀審查無 blocker。完整前端 34 files／379 tests passed，cleanup 等效寫法調整後 focused 16/16；build／TypeScript exit 0、lint exit 0（11 個既有 warnings）。未執行 Go、DB、Playwright 或 live Supabase，本輪僅前端變更。
- 每項獨立審查、commit 後執行 CodeGraph sync；四則 review 於推送後逐項回覆並讀回 resolved。

## 後續 review：升級後切換既有帳號的 Email 欄位（4058847339）

- 核實成立：resumeUpgrade 原本連登入分頁也隱藏 Email，使用者無法輸入既有帳號。
- 僅調整顯示條件，登入模式始終顯示 Email；註冊續接仍沿用原狀態。
- Sol 實作，主代理逐項審查欄位、切換與登入呼叫；新測試修正前因缺少 Email 失敗，修正後 AuthPage 67/67 passed。
- 回歸包含切登入、編輯 Email、離房確認，以及用編輯後 Email 呼叫 signInWithPassword。未宣稱 live Auth 驗收。

## 後續 review：提交時恢復已驗證升級（4058847344）

- 核實成立：getUser 尚未完成／失敗時，resumeUpgrade 初值為 false，使已驗證 session 誤入 signUp。
- getSession 後以目前 UID marker 與已驗證 Email 計算升級狀態；保留過期 UI state 的未驗證提示與更正 Email 路徑。
- Sol 實作、主代理審查；兩項新 regression 修改前 updateUser 呼叫 0 次而失敗，修正後 AuthPage 69/69 passed。前端完整 34 files／386 tests passed；build／TypeScript／lint exit 0，既有 11 warnings。
- 同時補正上一項新測試的 Supabase mock 型別；僅影響 TypeScript 測試 fixture，未改產品行為。未執行 live Auth。

## 後續 review：換地點後晚到的準備請求（4058847342）

- 核實成立：既有 RLS 只鎖房間並檢查 lobby，lobby 換地點後仍接受沒有地點版本的 ready PATCH。
- 新增 `20260921000100_round_bound_readiness.sql`：set_member_ready RPC 依 rooms → room_members 鎖序核對 search_version、lobby 與 auth.uid()；拒絕舊版、非成員及 null 輸入，撤銷 authenticated 直接更新 ready 的權限。
- ConditionsForm 仍先 flush 條件，再送點擊當時版本；版本改變後停止待送請求及忽略晚到回應，錯誤會還原並提示。RoomPage 傳入搜尋版本，E2E 攔截改為辨識準備 RPC；部署文件要求 migration 先行及舊頁重載。
- Sol 實作 SQL／Go concurrency tests，主代理審查；主代理實作前端，Sol 獨立只讀審查無 blocker。Go 雙連線測試實際觀察 pg_stat_activity 等待 room lock，覆蓋 relocation 先完成拒絕舊準備、準備先完成後被 relocation 重設、新版本成功。
- 前端新 RPC regression 修改前因零次 RPC 失敗，修改後 ConditionsForm 25/25、RoomPage 46/46 通過；另驗證 flush 期間換版、舊回應晚到、RPC false/error/rejection。完整前端 34 files／386 tests passed；build／TypeScript／lint 通過（11 個既有 warnings）。
- pgTAP 套 migration 前因缺少 RPC 失敗；套用後首次完整測試的 security fixture 使用錯誤 UUID（4000-8000 與實際 0000-0000 不同），一次測試修正後完整 8 files／172 assertions passed。未為測試修改產品邏輯。
- 隔離 DB 55322 的完整 go test ./... -count=1 PASS（10.720s），go vet ./... exit 0。Playwright 雙使用者完整閉環 PASS（42.5s）、QR 訪客／改地點／繼任／重轉閉環 PASS（31.6s）；不是完整 Playwright suite，未執行 race 或 live Auth 升級測試。
- 本輪只在既有 app_features 套用新 SQL，沒有 reset、操作原 DB 54322 或 production。migration 以單一 SQL transaction 套用，未寫入隔離環境的 Supabase migration history。

## 後續 review：本機確認信 redirect（4061390964）

- 核實成立：一般 Vite 啟動使用 HTTPS 5173，Email confirmation 已啟用，但 checked-in Auth URL 仍為 3000。
- Site URL 改為 `https://localhost:5173/#/auth`，allowlist 僅加入 localhost 與 127.0.0.1 的 HTTPS 5173 路徑。README 說明現有 stack 需重啟、LAN／其他 port 需加入明確網址；E2E 沿用預設設定。部署文件保留不得將本機 config push 至正式環境的限制。
- Sol 實作、主代理審查並要求修正 README 舊有手動設定段落；Python tomllib 解析與 diff 檢查通過。
- 把 checked-in 的兩項 URL 設定原樣帶入隔離 app_features（55321／55322／55324），逐一驗證兩個 origin 的真實 signup 確認信：Mailpit 連結保留指定 path/query/hash，驗證端點回導正確 HTTPS 5173 網址，Auth 帳號確認欄位已寫入。兩個測試帳號皆刪除並以 404 驗證不存在。
- 本項未啟動瀏覽器、未重新執行訪客升級全流程；未操作原 app stack 或 production。隔離 config 修改前已備份，驗收完已停止 task stack，並逐位元組確認 config 還原至備份。

## 後續 review：確認耗盡後刷新房間（4061390984）

- 核實成立：確認時全數候選失效已提交 lobby/reset，但 409 讓前端走不刷新的錯誤路徑，Realtime 斷線時停留在舊 pending 結果。
- 僅將成功提交 reset 的回應改為與 redraw 一致的 HTTP 200 `{status:"lobby", exhausted:true}`，沿用前端既有成功後 await refetch；仍有其他候選而 winner 單獨失效、版本衝突、未提交的錯誤路徑維持原語意。
- 新 DB regression 在原程式重現 409，修正後 7 項 pending 測試通過。核對候選／票數清空、準備重設、不寫 history、保留 draw audit、房籍與條件。
- 新 RoomPage regression 使用實際 confirmDraw/API helper 搭配模擬 HTTP 200 reset 回應，驗證 Realtime 斷線也 refetch 並呈現準備階段的搜尋按鈕。這是元件/API 測試，不是瀏覽器斷線 E2E。
- 隔離 DB 55322 的完整 Go suite 通過（10.456s）、go vet exit 0；前端 34 files／387 tests、build／TypeScript／lint 通過（11 個既有 lint warnings）。本輪沒有 migration、pgTAP、race 或 Playwright 執行。
- Sol 實作 server regression 與最小修正，主代理審查並補前端回歸；另一位 Sol 對 server／web 差異獨立唯讀審查，無 blocker。

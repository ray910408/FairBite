# 部署上線

前端 GitHub Pages（靜態）、後端 Render（Go）、資料庫 Supabase Cloud。
順序不能換：Supabase 產出的值是後面兩步的輸入。

## 1. Supabase Cloud

1. <https://supabase.com/dashboard> → New project。目前專案 ref 是 `zltocdydngmdnutzarlq`
   （region：Southeast Asia / Singapore `ap-southeast-1`，跟 Render 同區）。
2. 本機把 migrations 推上去（`link` 會互動式問 DB 密碼）：

   ```bash
   supabase link --project-ref zltocdydngmdnutzarlq
   ```

   ```bash
   supabase db push
   ```

3. Authentication → Sign In / Providers → Email：**關掉 Confirm email**。
   本專案只用 email + password，`signUp` 成功後直接導首頁；若開著確認信，
   註冊會拿不到 session 而彈回登入頁，且免費方案內建 SMTP 每小時只發 2 封。

   **不要用 `supabase config push` 代替這個開關**：本機 `config.toml` 的
   `site_url = "http://127.0.0.1:3000"` 會一起被推上去，把正式站的 auth 設定打壞。
4. 抄三個值備用：
   - Project URL `https://zltocdydngmdnutzarlq.supabase.co`
   - anon public key（Project Settings → API Keys）
   - **Session pooler** 連線字串（頂部 Connect 按鈕 → Session pooler 分頁，port 5432）

   為什麼是 session 而不是 transaction pooler：`server/main.go` 用 `pgxpool.New` 的預設
   query exec mode，會走 prepared statement；Supavisor transaction 模式（6543）不支援，
   要改成 session 模式（5432）或在連線字串加 `default_query_exec_mode=exec`。
   直連（db.\<ref\>.supabase.co）則是 IPv6-only，Render free 連不到。

## 2. Render

1. Render Dashboard → New → **Blueprint**，選這個 repo，它會讀根目錄 `render.yaml`。
2. 套用時填三個 `sync: false` 變數：
   - `SUPABASE_DB_URL` = 上一步的 pooler 連線字串（記得把 `[YOUR-PASSWORD]` 換成真密碼）
   - `SUPABASE_JWKS_URL` = `https://<ref>.supabase.co/auth/v1/.well-known/jwks.json`
   - `GOOGLE_PLACES_API_KEY` = GCP 的 Places API (New) key；留空則跑 14 家 mock
3. 部署完成後確認健康檢查：

   ```bash
   curl https://fairbite.onrender.com/healthz
   ```

服務名若改過，`WEB_ORIGIN` 不用動，但下一步的 `VITE_API_URL` 要跟著改。

**Free plan 會在閒置 15 分鐘後休眠**，之後第一個請求要等約 50 秒冷啟動。
Demo 前先打一次 `/healthz` 喚醒。

## 註冊 Email：Regex + DNS MX hook

註冊的格式檢查會先 trim、拒絕不完整網域、local part 首尾／連續句點，
TLD 限 2–63 個英文字母。Go hook 再查 DNS MX；沒有 MX、Null MX（明示不收信）
或 DNS 查詢失敗時拒絕建立帳號。依本產品要求採嚴格 MX 政策，不回退到 A/AAAA。
MX 通過只代表網域有郵件設定，不證明個別信箱存在或屬於使用者。

**只部署前端／後端程式不會自動啟用 MX。** 必須在 Supabase 啟用
Before User Created hook，才能攔住直接呼叫 Auth API 的註冊。前端仍使用
原本的 signUp，Supabase 在寫入 auth.users 前呼叫 hook；既有帳號登入不受影響。
本 hook 僅供目前的 email + password 註冊；日後加入電話或匿名註冊需先調整政策。

1. 先部署 Go 後端，確認公開 HTTPS 的
   POST /api/auth/before-user-created 可連線。尚未配置 secret 時回 503，
   配置後未簽章請求應回 401；這些都不是註冊成功的證據。
2. 在 Supabase Dashboard → Authentication → Hooks 建立 **Before User Created / HTTP**，
   URL 設為 https://<Go 後端網域>/api/auth/before-user-created，產生 signing secret。
   將完整的 v1,whsec_<base64-secret> 存入後端環境變數 SIGNUP_HOOK_SECRET，
   重新部署後端；不要將 secret 寫入 Git 或 VITE_*。
3. **後端就緒後才啟用 hook**，維持原本 Confirm email 關閉。Hook 有約 5 秒期限，
   DNS 查詢最多 2 秒，沒有應用層重試。repo 的 Render free plan 會休眠，冷啟動可能
   超過期限而使註冊失敗；正式使用前須改用不休眠的執行環境，或另將此 hook 部署到
   能滿足期限的服務。不能靠放行 DNS 故障來規避這個限制。
4. 在測試環境直接呼叫 Supabase signUp 驗證：23@d.d 格式拒絕；
   user@example.com 因 Null MX 拒絕；使用自己的可收信測試地址可建立帳號。
   前兩筆應回錯誤且 auth.users 無新增資料。DNS 故障時應顯示稍後再試。
   Hook 正常業務拒絕採 HTTP 200 加 error.http_code=422／error.message 的回應，
   讓 Auth 解析錯誤並停止建帳；不可只看 hook HTTP status 判定成功。
5. 若啟用失敗，先記錄 Auth hook 錯誤並停下處理；不要無限重試。
   回滾須停用該 hook 才回到舊的「只檢查格式」行為，應明確告知 MX 保護將消失。
   不需要 DB migration，也不刪除／修改任何既有帳號。

本機測試時先設定同一個 SIGNUP_HOOK_SECRET 給 Go server 與啟動 Supabase CLI
的環境，再取消 supabase/config.toml 內 [auth.hook.before_user_created] 的註解。
URI 使用 http://host.docker.internal:8787/api/auth/before-user-created。
只設定 server/.env 不會自動傳入 Supabase CLI；不要用 config push 改正式 auth 設定。

可重跑的驗證（在 server 目錄、PowerShell）：

~~~powershell
go test ./... -run '^TestSignup' -count=1
$env:TEST_SIGNUP_DNS = '1'
go test ./... -run '^TestSignupEmailLiveDNS$' -count=1 -v
Remove-Item Env:TEST_SIGNUP_DNS
~~~

第一個命令是離線格式／MX／簽章／路由回歸測試；第二個只實際查 DNS，不建立帳號。
Supabase 建帳整合驗證必須另行完成，不能用單元測試代替。

參考：[Before User Created](https://supabase.com/docs/guides/auth/auth-hooks/before-user-created-hook)、
[HTTP hook 錯誤處理](https://supabase.com/docs/guides/auth/auth-hooks#http-hooks)、
[Auth HTTP dispatcher](https://github.com/supabase/auth/blob/master/internal/hooks/hookshttp/hookshttp.go)、
[Null MX](https://www.rfc-editor.org/rfc/rfc7505.html)。

## 3. 前端設定值

編輯 [`web/.env.production`](../web/.env.production)，把三行換成實際值：

```
VITE_SUPABASE_URL=https://<ref>.supabase.co
VITE_SUPABASE_ANON_KEY=<anon key>
VITE_API_URL=https://fairbite.onrender.com
```

這三個值都會被打進 JS bundle，本來就是公開資訊；anon key 由 RLS 逐列把關，不是機密。
DB 連線字串與 Places key 只存在 Render，永遠不進前端。

## 4. GitHub Pages

1. repo → Settings → Pages → Source 選 **GitHub Actions**（不是 Deploy from a branch）。
2. push 到 `main`，`.github/workflows/deploy-pages.yml` 會 build 並部署。
3. 開 <https://ray910408.github.io/FairBite/>。

路由用 HashRouter，網址長 `…/FairBite/#/room/<id>`。Pages 沒有 SPA rewrite，
路徑形式的深連結由 `web/public/404.html` 轉成對應的 hash 路由（手打網址、
外部貼路徑連結的救援；站內導航本來就只產生 hash URL）。

## 日常 release 的 DB migration

push 到 `main` 時 `deploy-pages.yml` 的 `migrate` job 會自動 `supabase db push`，
前端部署被 `needs: migrate` 擋在後面——**DB 永遠先於前端**。需要兩個 repo secrets：
`SUPABASE_ACCESS_TOKEN`（Account → Access Tokens）與 `SUPABASE_DB_PASSWORD`。

已知限制：Render 的 Go 部署獨立監看 `main`，可能早於 migrate job 完成幾分鐘。
靠「migrations 只增不改（additive）」維持新舊相容；若未來出現非相容 migration，
先拆兩個 PR（先 DB 後程式）。

手動 fallback（Actions 壞掉時）：`supabase link --project-ref zltocdydngmdnutzarlq`
後 `supabase db push`。

> 教訓（2026-08-14 QA）：Round 1 的 0017 沒推上線，前端照常自動部署，
> 線上建房/進房整整壞了一天——`column rooms.meal_time does not exist`。

## 2026-09 安全修復部署閘門

這次 migrations `20260905000100`–`20260905000300` **不是新舊版本完全相容的更新**。
部署時先暫停舊 Go API 寫入／Render auto-deploy，備份資料庫，再依序套用 migrations、
部署新 Go 與 Web，最後恢復服務；不可讓舊評分程式在快照清理後重新寫入私人統計。
舊 SPA 需重新載入：`profiles.default_prefs` 改由只讀本人的 `get_my_default_prefs()` RPC 取得。
Go 若先啟動而配額 schema 尚未存在，搜尋會回 503（fail closed），不會先呼叫付費 API。

- Migration `20260905000100` 驗證既有名字與偏好：名稱 1–80 字／最多 320 bytes；
  菜系最多 20 項、dietary 最多 10 項，每項最多 64 bytes，僅允許目前詞彙且不得重複。
  違規舊資料會阻擋 migration；先由擁有者明確修正，不自動刪除／截斷飲食選擇。
  2026-09-06 已確認 production 僅一筆舊 `["no_pork"]`（現行引擎已忽略此選項）。
  經擁有者同意，可先執行 `supabase db query --linked --file supabase/repairs/20260906_legacy_dietary.sql`，
  再重跑失敗的 Deploy web。此 SQL 在同一原子操作內將原值存至
  `private_member_repairs.dietary_20260906` 後改為 `[]`，不改其他偏好或既有 migrations。
  備份僅 DB owner 可讀，不隨房間刪除；重跑不覆寫原值。若相符資料超過一筆則停止，需重新確認。
  當日已執行：備份／修復各 1 筆，會員總數仍為 5；Deploy web run `34007525252`
  第 2 次執行成功，3 個安全 migrations 與 Pages 部署完成。新增回歸測試為
  `server/dietary_repair_test.go`，隔離 DB 的 Go vet／race 與 119 項 pgTAP 均通過。
- 配額存在 `public.resource_quota_limits`，僅管理員可調整：建房 5 次／10 分鐘、
  20 次／UTC 日、最多 5 個活躍房（逾 24 小時 lobby 不計入，不刪除）；
  搜尋 5 次／10 分鐘、30 次／UTC 日；Google 最壞呼叫預留每帳號 120 次／日、
  全站 10000 次／日；跨 instances 最多 4 個搜尋，45 秒 deadline／60 秒失效 lease。
  window 為固定起算 10 分鐘；失敗或未用完的預留不退款，重啟／刪房不重設帳號額度。
  單次目前最多預留 32 個 HTTP calls。預算是 request 數，不是固定貨幣金額。
- 未滿 4 人的房間不使用 recency／exposure／satisfaction 計分；4 人以上使用粗化統計，
  不再顯示精確人次，但不承諾對串通成員提供不可推論性或 differential privacy。
- Migration `20260905000300` 先鎖定並封存所有原始候選／抽選資料至 `private_scoring`，
  再隱藏公開舊機率與權重。winner、seed 不變，舊機率不被偽造或重算；
  原始稽核僅資料庫 owner 可存取，不公開給 REST service role。
  未完成房間在開始投票／投票／抽選時恢復新規則機率；已抽選 UI 顯示「歷史機率已隱藏」。
- 新 migrations 使用 timestamp，避免與本機曾出現、但不在此 checkout 的 `0026_search_calls`
  版本號衝突。部署前仍須比對目標 migration history；本次只驗證隔離 DB，沒有修改 production。

## 換網域或改服務名時

CORS 只允許單一來源。改前端網域時要同時改兩處，少一處就整站 API 全部被瀏覽器擋：

- Render 的 `WEB_ORIGIN`（只填 origin，不含 `/FairBite` 路徑）
- `web/.env.production` 的 `VITE_API_URL`（改後端網域時）
- 改成 root 網域（custom domain）時，同步調整 `web/public/404.html` 的 base 推導；目前寫死取第一段路徑（project site 前提），root 下會把 `/room/abc` 誤判成 base `/room/` 而轉址迴圈

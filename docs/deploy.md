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
BrowserRouter 的深連結會 404，hash 路由省掉 `404.html` 轉址 hack。

## 換網域或改服務名時

CORS 只允許單一來源。改前端網域時要同時改兩處，少一處就整站 API 全部被瀏覽器擋：

- Render 的 `WEB_ORIGIN`（只填 origin，不含 `/FairBite` 路徑）
- `web/.env.production` 的 `VITE_API_URL`（改後端網域時）

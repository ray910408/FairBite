# 今天吃什麼 — 多人餐廳決策與公平抽選

多人房間 + 條件過濾 + 加權可解釋機率 + 伺服器抽選。詞彙表見 `CONTEXT.md`，
決策紀錄見 `docs/adr/`，三分鐘雙瀏覽器展示流程見 `docs/demo-script.md`，
待辦與已知限制見 `TODOS.md`。（設計文件與 SDD ledger 在 `docs/superpowers/`，
未納入版控，僅存在於本機工作目錄。）

## 架構

```mermaid
flowchart TB
  subgraph W["瀏覽器 — web/（React + Vite）"]
    UI["RoomPage / ConditionsForm / Wheel"]
  end

  subgraph G["Go API — server/（:8787）"]
    MW["cors → JWKS 驗證 → per-user 限流"]
    H["handlers<br/>search / start-voting / vote / draw"]
    E["engine<br/>硬性排除 + 權重因素 → 機率"]
    D["draw<br/>留 seed 的加權隨機"]
    P["PlacesProvider"]
  end

  subgraph S["Supabase Postgres（RLS）"]
    T["rooms / room_members / room_candidates<br/>votes / draws"]
    C["restaurants — 30 天快取"]
  end

  GP["Google Places API v1"]

  UI -->|"PostgREST：create_room / join_room RPC、寫條件、讀候選"| T
  T -->|"Realtime postgres_changes（room-房號頻道）"| UI
  UI -->|"POST /api/rooms/:id/…"| MW
  MW --> H
  H --> E --> D
  H --> P
  P -->|"有 GOOGLE_PLACES_API_KEY"| GP
  P -->|"未設：13 家 mock"| C
  GP -->|"失敗 → 降級改用快取 + 前端橫幅"| C
  C --> H
  H -->|"pgxpool（服務身分，不受 RLS 限制）"| T
```

兩條路徑的分工是這套系統唯一需要記住的規則：**唯讀與個人資料直打 Supabase，
會改變房間狀態的動作一律走 Go API**。前者（建房、加入、填自己的條件、讀候選與
票數）由 RLS 逐列把關，改動經 Realtime 即時推播給同房其他人；後者（搜尋、開始
投票、投票、抽選）需要凍結成員條件、跑過濾與加權、留下可重播的 seed，這些跨列
的一致性只有伺服器端交易做得到，因此 handlers 以 pgxpool 服務身分寫入。

搜尋結果先落進 `restaurants` 快取（Google 條款上限 30 天）；Google 呼叫失敗時
handlers 改用快取並在回應標記 `degraded`，前端顯示降級橫幅。已歇業的店家
（`businessStatus` 非營業中）會在快取中留下 tombstone，之後不再進入候選。
資料來源為 Google 的候選會自動顯示「餐廳資料 Powered by Google」歸因。
天氣因素使用免金鑰的 Open-Meteo；天氣資料：Open-Meteo.com（CC BY 4.0）。

## 本地啟動

首次啟動前先把 `server/.env.example` 複製成 `server/.env` 並填值（該檔已被 `.gitignore`
排除）。Go server 啟動時以 godotenv 讀取它，之後 shell 語法在 Git Bash 與 PowerShell
一致。真環境變數優先於 `.env`，部署時由平台注入即可，不需要這個檔案。

Windows 一鍵啟動（Supabase + Go API + Vite，後兩者各開獨立視窗）：

```powershell
.\dev.ps1          # 桌機開發，Vite 自動開瀏覽器
.\dev.ps1 -Lan     # 手機同網段測試，印出手機要開的區網網址
```

手動起（或非 Windows），三個終端：

```bash
# 1. Supabase local stack
supabase start        # 記下 anon key

# 2. Go 核心服務
cd server && cp .env.example .env   # 首次；之後直接 go run .
go run .

# 3. Web
cd web && npm i && npm run dev   # .env.local 填 anon key
```

新版 supabase CLI local stack 簽發 ES256 token，一律用 JWKS；`SUPABASE_JWT_SECRET`
僅適用仍在 legacy 對稱簽章的舊專案（HS256，2026 年底棄用）。

| Go 環境變數 | 必填 | 說明 |
| --- | --- | --- |
| `SUPABASE_DB_URL` | 是 | Postgres 連線字串；handlers 以此身分寫入候選與抽選。 |
| `SUPABASE_JWKS_URL` | 是 | 驗證前端 access token 的 JWKS 端點（ES256）。 |
| `GOOGLE_PLACES_API_KEY` | 否 | 未設定時使用 mock provider；僅供 Go server 使用，絕不放入 web bundle。Google 來源資料會自動顯示「餐廳資料 Powered by Google」歸因；正式上線前的 logo 資產版本檢查見 `TODOS.md`。 |
| `APP_TZ` | 否（選填） | 預設 `Asia/Taipei`；營業時間一律以此時區評估；per-place 時區留待未來。 |
| `PORT` | 否 | 預設 `8787`。 |
| `WEB_ORIGIN` | 否 | CORS 允許來源，預設 `http://localhost:5173`；只吃單一來源，手機/區網測試時填區網 IP（桌機瀏覽器也要改用同一個 IP 開）；部署時要改成正式前端網域。 |

## 測試

Git Bash（每行獨立執行，皆從 repo 根目錄開始）：

```bash
supabase test db                                   # RLS pgTAP
(cd server && go test ./...)                       # 引擎/抽選/auth
(cd server && TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' go test ./... -run 'TestSearchAndDraw|TestSearchEdge' -v)
(cd web && npm test)                               # 機率顯示與 maps URL
(cd web && npm run lint)                           # rules-of-hooks 這類 tsc 抓不到的錯
(cd web && npm run build)                          # 型別檢查 + 產出
```

PowerShell：

```powershell
supabase test db
Push-Location server; go test ./...; Pop-Location
Push-Location server; $env:TEST_DATABASE_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'; go test ./... -run 'TestSearchAndDraw|TestSearchEdge' -v; Pop-Location
Push-Location web; npm test; Pop-Location
Push-Location web; npm run lint; Pop-Location
Push-Location web; npm run build; Pop-Location
```

## E2E 測試

雙客戶端完整閉環 E2E 執行前，需先依「本地啟動」讓三個服務保持運行：Supabase local、使用 mock provider 與 local JWKS 的 Go API，以及 Vite dev server。另開一個 PowerShell 終端執行：

```powershell
$env:PLAYWRIGHT_BROWSERS_PATH = "0"
cd web
npx playwright install chromium # 首次執行需下載瀏覽器
npm run e2e
```

E2E 尚未接入 CI，因為 CI 需額外編排整套 local stack；`TODOS.md` 保留後續 CI 編排評估。

未設定 `GOOGLE_PLACES_API_KEY` 時使用台北車站周邊 13 家 mock 餐廳；設定後即切換至 Google Places provider。

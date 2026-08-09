# 今天吃什麼 — 多人餐廳決策與公平抽選

多人房間 + 條件過濾 + 加權可解釋機率 + 伺服器抽選。詞彙表見 `CONTEXT.md`，
決策紀錄見 `docs/adr/`。（設計文件與 SDD ledger 在 `docs/superpowers/`，
未納入版控，僅存在於本機工作目錄。）

## 本地啟動（三個終端）

Git Bash：

```bash
# 1. Supabase local stack
supabase start        # 記下 anon key

# 2. Go 核心服務
cd server
SUPABASE_DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
SUPABASE_JWKS_URL='http://127.0.0.1:54321/auth/v1/.well-known/jwks.json' \
go run .

# 3. Web
cd web && npm i && npm run dev   # .env.local 填 anon key
```

PowerShell（同三個終端，只是環境變數語法不同）：

```powershell
# 2. Go 核心服務
cd server
$env:SUPABASE_DB_URL = 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'
$env:SUPABASE_JWKS_URL = 'http://127.0.0.1:54321/auth/v1/.well-known/jwks.json'
go run .
```

新版 supabase CLI local stack 簽發 ES256 token，一律用 JWKS；`SUPABASE_JWT_SECRET`
僅適用仍在 legacy 對稱簽章的舊專案（HS256，2026 年底棄用）。

| Go 環境變數 | 必填 | 說明 |
| --- | --- | --- |
| `GOOGLE_PLACES_API_KEY` | 否 | 未設定時使用 mock provider；僅供 Go server 使用，絕不放入 web bundle。 |

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

Phase 1 使用 mock 餐廳資料（台北車站周邊 13 家）；真實 Google Places 於 Phase 2 切換。

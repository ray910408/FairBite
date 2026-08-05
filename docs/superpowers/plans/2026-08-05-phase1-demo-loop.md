# Phase 1「可 demo 閉環」Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 完成「註冊登入 → 建房/邀請碼加入 → 條件設定 → 硬性過濾+核心權重 → 伺服器抽選 → 轉盤顯示真實機率與解釋 → Google Maps 跳轉」的完整閉環，Places 用 mock provider，房間狀態即時同步。

**Architecture:** React SPA 直連 Supabase（Auth、讀取、RLS 保護的簡單寫入、Realtime 訂閱）；Go 服務負責搜尋/過濾/計分/抽選並以 service role 寫回 Postgres；DB 為單一真相。詳見 spec：`docs/superpowers/specs/2026-08-05-group-restaurant-decision-app-design.md`，詞彙見 `/CONTEXT.md`。

**Tech Stack:** React 19 + Vite 7 + TypeScript + Tailwind v4 + @supabase/supabase-js v2 + react-router-dom v7 + vitest；Go 1.23+（stdlib `net/http` 路由、`github.com/golang-jwt/jwt/v5`、`github.com/MicahParks/keyfunc/v3`、`github.com/jackc/pgx/v5`）；Supabase CLI local stack（Postgres + Auth + Realtime）+ pgTAP。

## Global Constraints

- 語言：所有 UI 文案與 trace reason 一律繁體中文；程式識別字英文
- 版本下限：Node 20+、Go 1.23+、Supabase CLI 最新版
- 不做過敏功能：任何欄位、文案不得出現「過敏」（ADR-0001）
- 無群組實體（ADR-0002）；P1 不建 `votes`/`dining_history`/`exposure_stats`（P2 再加 migration）
- 所有可調參數（倍率、金額換算、速度、門檻）只能放 `server/weights.go`
- 所有 JSON 欄位命名 snake_case（Go 回應與 DB 欄位一致）
- 房間狀態轉換一律 conditional update（`WHERE status='<expected>'`），失敗回 409
- Go 服務 port 8787；Vite dev port 5173；Supabase local API `http://127.0.0.1:54321`、DB `postgresql://postgres:postgres@127.0.0.1:54322/postgres`
- 秘密只進環境變數：`SUPABASE_JWT_SECRET`（或 `SUPABASE_JWKS_URL`）、`SUPABASE_DB_URL`；前端只可持有 anon key
- Commit 訊息用 conventional commits；每個 task 至少一個 commit
- TDD：先寫測試、跑紅、實作、跑綠、commit
- 產生資料/設定檔一律用編輯工具寫檔，不用 shell `>` 重導（rtk 環境下重導可能截斷）

---

### Task 1: Monorepo 骨架 + Supabase schema、RLS、pgTAP 測試

預估 60–90 分鐘。

**Files:**
- Create: `.gitignore`
- Create: `supabase/migrations/0001_init.sql`
- Create: `supabase/tests/rls_test.sql`
- （`supabase init` 會生成 `supabase/config.toml`）

**Interfaces:**
- Consumes: 無（第一個 task）
- Produces: 資料表 `profiles`、`rooms`、`rooms.code`（6 碼邀請碼）、`room_members`、`restaurants`、`room_candidates`、`draws`；SQL functions `create_room(p_lat, p_lng) returns uuid`、`join_room(p_code) returns uuid`、`is_room_member(p_room_id) returns boolean`；Realtime publication 含 `rooms`/`room_members`/`room_candidates`/`draws`。後續所有 task 依賴這些名稱。

- [ ] **Step 1: 初始化 repo 結構與 supabase 專案**

```bash
cd D:/app && supabase init
```

寫入 `.gitignore`：

```gitignore
node_modules/
dist/
.env
.env.local
server/server
server/server.exe
supabase/.temp/
```

- [ ] **Step 2: 寫 migration**

寫入 `supabase/migrations/0001_init.sql`（完整內容）：

```sql
-- P1 tables. votes / dining_history / exposure_stats 屬 P2，另開 migration。

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  default_prefs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
  host_id uuid not null references public.profiles(id),
  status text not null default 'lobby' check (status in ('lobby','candidates','decided')),
  center_lat double precision,
  center_lng double precision,
  exploration text not null default 'balanced' check (exploration in ('familiar','balanced','explore')),
  created_at timestamptz not null default now()
);

create table public.room_members (
  room_id uuid references public.rooms(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  budget_max int not null default 300,
  cuisines jsonb not null default '[]',
  dietary jsonb not null default '[]',
  max_distance_m int not null default 800,
  transport text not null default 'walking' check (transport in ('walking','driving','transit')),
  ready boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  place_id text not null unique,
  name text not null,
  cuisine_tags jsonb not null default '[]',
  price_level int not null default 2,
  lat double precision not null,
  lng double precision not null,
  address text not null default '',
  opening_hours jsonb not null default '{}',
  rating numeric,
  fetched_at timestamptz not null default now()
);

create table public.room_candidates (
  room_id uuid references public.rooms(id) on delete cascade,
  restaurant_id uuid references public.restaurants(id),
  status text not null check (status in ('kept','excluded')),
  probability numeric,
  weight_breakdown jsonb not null default '[]',
  exclusion_reason text,
  primary key (room_id, restaurant_id)
);

create table public.draws (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null unique references public.rooms(id) on delete cascade,
  seed text not null,
  winner_restaurant_id uuid not null references public.restaurants(id),
  probabilities jsonb not null,
  created_at timestamptz not null default now()
);

-- 新使用者自動建 profile
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS helper：security definer 避免 room_members 政策自我遞迴
create or replace function public.is_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from room_members where room_id = p_room_id and user_id = auth.uid());
$$;

-- 建房與加入走 security definer：原子性 + 不需開放 rooms 的 insert/select-by-code 政策
create or replace function public.create_room(p_lat double precision, p_lng double precision)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room_id uuid;
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  insert into rooms (host_id, center_lat, center_lng)
  values (auth.uid(), p_lat, p_lng) returning id into v_room_id;
  insert into room_members (room_id, user_id) values (v_room_id, auth.uid());
  return v_room_id;
end $$;

create or replace function public.join_room(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room_id uuid;
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  select id into v_room_id from rooms where code = upper(trim(p_code)) and status = 'lobby';
  if v_room_id is null then raise exception '房間不存在或已開始'; end if;
  insert into room_members (room_id, user_id) values (v_room_id, auth.uid())
  on conflict do nothing;
  return v_room_id;
end $$;

revoke execute on function public.create_room, public.join_room, public.is_room_member from anon, public;
grant execute on function public.create_room, public.join_room, public.is_room_member to authenticated;

-- RLS
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.restaurants enable row level security;
alter table public.room_candidates enable row level security;
alter table public.draws enable row level security;

-- ponytail: default_prefs 對所有登入者可讀（低敏感），P2 若要收緊改用 view
create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy rooms_select on public.rooms for select to authenticated using (is_room_member(id));
-- ponytail: host 可 update 整列（含 status）；惡意 host 只能弄壞自己房間，P2 再用 trigger 鎖 status
create policy rooms_update on public.rooms for update to authenticated
  using (host_id = auth.uid()) with check (host_id = auth.uid());

create policy members_select on public.room_members for select to authenticated using (is_room_member(room_id));
create policy members_update on public.room_members for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

create policy restaurants_select on public.restaurants for select to authenticated using (true);
create policy candidates_select on public.room_candidates for select to authenticated using (is_room_member(room_id));
create policy draws_select on public.draws for select to authenticated using (is_room_member(room_id));
-- 沒有任何 to authenticated 的 insert/delete 政策：寫入走 definer functions 與 Go service role

-- Realtime
alter publication supabase_realtime add table public.rooms, public.room_members, public.room_candidates, public.draws;
```

- [ ] **Step 3: 寫 RLS 測試（先確認會失敗的方式：先跑一次空測試目錄）**

寫入 `supabase/tests/rls_test.sql`：

```sql
begin;
create extension if not exists pgtap with schema extensions;
select plan(5);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@test.dev'),
  ('00000000-0000-0000-0000-0000000000b2', 'b@test.dev');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select lives_ok($$select public.create_room(25.0478, 121.5170)$$, 'A 可建房');
create temp table ctx as select id, code from public.rooms limit 1;

set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*) from public.rooms)::int, 0, 'B 未加入前看不到房間');
select lives_ok(format($$select public.join_room(%L)$$, (select code from ctx)), 'B 可用邀請碼加入');
select is((select count(*) from public.rooms)::int, 1, 'B 加入後看得到房間');

update public.room_members set ready = true
  where user_id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select count(*) from public.room_members
    where user_id = '00000000-0000-0000-0000-0000000000a1' and ready)::int,
  0, 'B 改不動 A 的成員列');

select * from finish();
rollback;
```

- [ ] **Step 4: 啟動 local stack、套 migration、跑測試**

```bash
supabase start && supabase db reset && supabase test db
```

Expected: `db reset` 無錯誤；pgTAP 5/5 ok。失敗就修 migration 直到全綠。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat: supabase schema, RLS policies and pgTAP tests"
```

---

### Task 2: Go 服務骨架 — healthz + JWT middleware

預估 45 分鐘。

**Files:**
- Create: `server/go.mod`（`go mod init server`）
- Create: `server/main.go`
- Create: `server/auth.go`
- Test: `server/auth_test.go`

**Interfaces:**
- Consumes: 環境變數 `SUPABASE_JWT_SECRET`（local 預設 `super-secret-jwt-token-with-at-least-32-characters-long`）或 `SUPABASE_JWKS_URL`、`PORT`、`WEB_ORIGIN`
- Produces: `NewVerifier() (*Verifier, error)`、`(*Verifier).Middleware(http.Handler) http.Handler`、`UserID(*http.Request) string`；`GET /healthz` 回 `{"ok":true}`。Task 7 的 handlers 掛在這個 middleware 之後。

- [ ] **Step 1: 寫失敗測試**

`server/auth_test.go`：

```go
package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func signHS256(t *testing.T, secret, sub string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": sub, "exp": time.Now().Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAuthMiddleware(t *testing.T) {
	t.Setenv("SUPABASE_JWT_SECRET", "test-secret-test-secret-test-secret!")
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	h := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(UserID(r)))
	}))

	r1 := httptest.NewRequest("GET", "/x", nil)
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, r1)
	if w1.Code != http.StatusUnauthorized {
		t.Fatalf("no token: want 401 got %d", w1.Code)
	}

	r2 := httptest.NewRequest("GET", "/x", nil)
	r2.Header.Set("Authorization", "Bearer not-a-jwt")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("bad token: want 401 got %d", w2.Code)
	}

	r3 := httptest.NewRequest("GET", "/x", nil)
	r3.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", "user-123"))
	w3 := httptest.NewRecorder()
	h.ServeHTTP(w3, r3)
	if w3.Code != http.StatusOK || w3.Body.String() != "user-123" {
		t.Fatalf("valid token: got %d %q", w3.Code, w3.Body.String())
	}
}
```

- [ ] **Step 2: 跑紅**

```bash
cd D:/app/server && go mod init server && go get github.com/golang-jwt/jwt/v5 github.com/MicahParks/keyfunc/v3 && go test ./...
```

Expected: FAIL（`NewVerifier` undefined）。

- [ ] **Step 3: 實作 auth.go 與 main.go**

`server/auth.go`：

```go
package main

import (
	"context"
	"net/http"
	"os"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

type ctxKey string

const userIDKey ctxKey = "userID"

type Verifier struct{ keyfunc jwt.Keyfunc }

func NewVerifier() (*Verifier, error) {
	if url := os.Getenv("SUPABASE_JWKS_URL"); url != "" {
		kf, err := keyfunc.NewDefaultCtx(context.Background(), []string{url})
		if err != nil {
			return nil, err
		}
		return &Verifier{keyfunc: kf.Keyfunc}, nil
	}
	secret := []byte(os.Getenv("SUPABASE_JWT_SECRET"))
	return &Verifier{keyfunc: func(t *jwt.Token) (any, error) { return secret, nil }}, nil
}

func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		raw := strings.TrimPrefix(auth, "Bearer ")
		if raw == "" || raw == auth {
			jsonError(w, http.StatusUnauthorized, "missing token")
			return
		}
		claims := jwt.MapClaims{}
		_, err := jwt.ParseWithClaims(raw, claims, v.keyfunc,
			jwt.WithValidMethods([]string{"HS256", "RS256", "ES256"}))
		if err != nil {
			jsonError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		sub, _ := claims.GetSubject()
		if sub == "" {
			jsonError(w, http.StatusUnauthorized, "no sub claim")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userIDKey, sub)))
	})
}

func UserID(r *http.Request) string {
	s, _ := r.Context().Value(userIDKey).(string)
	return s
}
```

`server/main.go`：

```go
package main

import (
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
)

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func cors(next http.Handler) http.Handler {
	origin := os.Getenv("WEB_ORIGIN")
	if origin == "" {
		origin = "http://localhost:5173"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	verifier, err := NewVerifier()
	if err != nil {
		log.Fatal(err)
	}
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, map[string]bool{"ok": true})
	})
	// Task 7 會把真正的 /api 路由掛進來；先掛 middleware 驗證接線
	mux.Handle("/api/", verifier.Middleware(http.NotFoundHandler()))

	port := os.Getenv("PORT")
	if port == "" {
		port = "8787"
	}
	log.Printf("listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, cors(mux)))
}
```

- [ ] **Step 4: 跑綠**

```bash
go test ./... && go vet ./...
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): scaffold with healthz and supabase JWT middleware"
```

---

### Task 3: Places provider 介面 + mock 資料

預估 45 分鐘。

**Files:**
- Create: `server/places.go`
- Create: `server/mockdata.go`
- Test: `server/places_test.go`

**Interfaces:**
- Consumes: 無
- Produces:

```go
type OpeningHours map[string][][2]int // "sun".."sat" → [開店分, 打烊分]；打烊<開店 = 跨夜
func (oh OpeningHours) IsOpenAt(t time.Time) bool
func (oh OpeningHours) MinutesUntilClose(t time.Time) int // 未營業回 -1

type Restaurant struct {
	ID          string // DB uuid，provider 回傳時留空，upsert 後補
	PlaceID     string
	Name        string
	CuisineTags []string
	PriceLevel  int
	Lat, Lng    float64
	Address     string
	Hours       OpeningHours
	Rating      float64
}

type PlacesProvider interface {
	SearchNearby(ctx context.Context, lat, lng float64, radiusM int) ([]Restaurant, error)
}

func NewMockProvider() PlacesProvider
func Haversine(lat1, lng1, lat2, lng2 float64) float64 // 公尺
```

Task 4/5 吃 `Restaurant`/`OpeningHours`，Task 7 吃 `PlacesProvider`。

- [ ] **Step 1: 寫失敗測試**

`server/places_test.go`：

```go
package main

import (
	"context"
	"testing"
	"time"
)

func at(weekday time.Weekday, hh, mm int) time.Time {
	// 2026-08-02 是週日；加 weekday 天得到該星期各日
	base := time.Date(2026, 8, 2, 0, 0, 0, 0, time.Local)
	return base.AddDate(0, 0, int(weekday)).Add(time.Duration(hh)*time.Hour + time.Duration(mm)*time.Minute)
}

func TestOpeningHours(t *testing.T) {
	oh := OpeningHours{"mon": {{660, 1350}}} // 週一 11:00–22:30
	if !oh.IsOpenAt(at(time.Monday, 12, 0)) {
		t.Error("週一中午應為營業中")
	}
	if oh.IsOpenAt(at(time.Monday, 23, 0)) {
		t.Error("週一 23:00 應為未營業")
	}
	if oh.IsOpenAt(at(time.Tuesday, 12, 0)) {
		t.Error("週二未定義應為未營業")
	}
	if got := oh.MinutesUntilClose(at(time.Monday, 22, 0)); got != 30 {
		t.Errorf("22:00 距打烊應為 30，got %d", got)
	}
}

func TestOpeningHoursOvernight(t *testing.T) {
	oh := OpeningHours{"fri": {{1020, 120}}} // 週五 17:00–翌日 02:00
	if !oh.IsOpenAt(at(time.Friday, 23, 0)) {
		t.Error("週五 23:00 應為營業中")
	}
	if !oh.IsOpenAt(at(time.Saturday, 1, 0)) {
		t.Error("週六 01:00（跨夜段）應為營業中")
	}
	if oh.IsOpenAt(at(time.Saturday, 3, 0)) {
		t.Error("週六 03:00 應為未營業")
	}
}

func TestMockProviderRadius(t *testing.T) {
	p := NewMockProvider()
	all, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 2000)
	if err != nil || len(all) < 10 {
		t.Fatalf("2km 內應有至少 10 家，got %d err %v", len(all), err)
	}
	near, _ := p.SearchNearby(context.Background(), 25.0478, 121.5170, 300)
	if len(near) == 0 || len(near) >= len(all) {
		t.Fatalf("300m 應為非空真子集，got %d / %d", len(near), len(all))
	}
	for _, r := range near {
		if Haversine(25.0478, 121.5170, r.Lat, r.Lng) > 300 {
			t.Errorf("%s 超出半徑", r.Name)
		}
	}
}
```

- [ ] **Step 2: 跑紅**

```bash
go test ./... -run 'TestOpening|TestMock'
```

Expected: FAIL（型別未定義）。

- [ ] **Step 3: 實作**

`server/places.go`：

```go
package main

import (
	"context"
	"math"
	"time"
)

type OpeningHours map[string][][2]int

var weekdayKeys = [...]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

func minuteOfDay(t time.Time) int { return t.Hour()*60 + t.Minute() }

func (oh OpeningHours) IsOpenAt(t time.Time) bool {
	m := minuteOfDay(t)
	for _, span := range oh[weekdayKeys[t.Weekday()]] {
		open, close := span[0], span[1]
		if close > open && m >= open && m < close {
			return true
		}
		if close <= open && m >= open { // 跨夜段的當日部分
			return true
		}
	}
	prev := weekdayKeys[(int(t.Weekday())+6)%7]
	for _, span := range oh[prev] { // 前一日跨夜延伸到今天
		if span[1] <= span[0] && m < span[1] {
			return true
		}
	}
	return false
}

func (oh OpeningHours) MinutesUntilClose(t time.Time) int {
	m := minuteOfDay(t)
	for _, span := range oh[weekdayKeys[t.Weekday()]] {
		open, close := span[0], span[1]
		if close > open && m >= open && m < close {
			return close - m
		}
		if close <= open && m >= open {
			return (1440 - m) + close
		}
	}
	prev := weekdayKeys[(int(t.Weekday())+6)%7]
	for _, span := range oh[prev] {
		if span[1] <= span[0] && m < span[1] {
			return span[1] - m
		}
	}
	return -1
}

type Restaurant struct {
	ID          string
	PlaceID     string
	Name        string
	CuisineTags []string
	PriceLevel  int
	Lat, Lng    float64
	Address     string
	Hours       OpeningHours
	Rating      float64
}

type PlacesProvider interface {
	SearchNearby(ctx context.Context, lat, lng float64, radiusM int) ([]Restaurant, error)
}

func Haversine(lat1, lng1, lat2, lng2 float64) float64 {
	const r = 6371000.0
	toRad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat, dLng := toRad(lat2-lat1), toRad(lng2-lng1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(toRad(lat1))*math.Cos(toRad(lat2))*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * r * math.Asin(math.Sqrt(a))
}

type mockProvider struct{}

func NewMockProvider() PlacesProvider { return mockProvider{} }

func (mockProvider) SearchNearby(_ context.Context, lat, lng float64, radiusM int) ([]Restaurant, error) {
	var out []Restaurant
	for _, r := range mockRestaurants {
		if Haversine(lat, lng, r.Lat, r.Lng) <= float64(radiusM) {
			out = append(out, r)
		}
	}
	return out, nil
}
```

`server/mockdata.go`（台北車站周邊 12 家；`daily` helper 讓每天同時段）：

```go
package main

func daily(spans ...[2]int) OpeningHours {
	oh := OpeningHours{}
	for _, k := range weekdayKeys {
		oh[k] = append([][2]int{}, spans...)
	}
	return oh
}

var mockRestaurants = []Restaurant{
	{PlaceID: "mock-001", Name: "阿宗麵線", CuisineTags: []string{"taiwanese", "noodle"}, PriceLevel: 0, Lat: 25.0466, Lng: 121.5076, Address: "萬華區峨眉街8-1號", Hours: daily([2]int{660, 1350}), Rating: 4.4},
	{PlaceID: "mock-002", Name: "一蘭拉麵", CuisineTags: []string{"japanese", "ramen"}, PriceLevel: 2, Lat: 25.0455, Lng: 121.5170, Address: "中正區忠孝西路一段", Hours: daily([2]int{0, 1440}), Rating: 4.2},
	{PlaceID: "mock-003", Name: "金峰滷肉飯", CuisineTags: []string{"taiwanese"}, PriceLevel: 0, Lat: 25.0440, Lng: 121.5130, Address: "中正區羅斯福路一段", Hours: daily([2]int{480, 1230}), Rating: 4.3},
	{PlaceID: "mock-004", Name: "添好運", CuisineTags: []string{"cantonese", "dimsum"}, PriceLevel: 2, Lat: 25.0460, Lng: 121.5175, Address: "中正區忠孝西路一段36號", Hours: daily([2]int{600, 1290}), Rating: 4.1},
	{PlaceID: "mock-005", Name: "韓雞屋", CuisineTags: []string{"korean", "fried_chicken"}, PriceLevel: 2, Lat: 25.0495, Lng: 121.5210, Address: "中山區南京西路", Hours: daily([2]int{660, 1320}), Rating: 4.0},
	{PlaceID: "mock-006", Name: "慕里諾牛排館", CuisineTags: []string{"steak", "western"}, PriceLevel: 4, Lat: 25.0500, Lng: 121.5150, Address: "大同區承德路一段", Hours: daily([2]int{690, 1260}), Rating: 4.5},
	{PlaceID: "mock-007", Name: "春天素食", CuisineTags: []string{"vegetarian_friendly", "taiwanese"}, PriceLevel: 3, Lat: 25.0470, Lng: 121.5230, Address: "中正區忠孝東路一段", Hours: daily([2]int{690, 1230}), Rating: 4.2},
	{PlaceID: "mock-008", Name: "老四川麻辣鍋", CuisineTags: []string{"hotpot", "sichuan"}, PriceLevel: 3, Lat: 25.0512, Lng: 121.5195, Address: "大同區南京西路", Hours: daily([2]int{1020, 120}), Rating: 4.4},
	{PlaceID: "mock-009", Name: "沙巴印度咖哩", CuisineTags: []string{"indian", "curry"}, PriceLevel: 1, Lat: 25.0430, Lng: 121.5190, Address: "中正區開封街一段", Hours: daily([2]int{660, 1260}), Rating: 4.1},
	{PlaceID: "mock-010", Name: "林東芳牛肉麵", CuisineTags: []string{"taiwanese", "beef_noodle"}, PriceLevel: 1, Lat: 25.0478, Lng: 121.5260, Address: "中山區八德路二段", Hours: daily([2]int{660, 180}), Rating: 4.5},
	{PlaceID: "mock-011", Name: "早安美芝城", CuisineTags: []string{"breakfast", "taiwanese"}, PriceLevel: 0, Lat: 25.0485, Lng: 121.5140, Address: "大同區太原路", Hours: daily([2]int{330, 840}), Rating: 3.9},
	{PlaceID: "mock-012", Name: "藏壽司", CuisineTags: []string{"japanese", "sushi", "seafood"}, PriceLevel: 2, Lat: 25.0490, Lng: 121.5165, Address: "中正區市民大道一段", Hours: daily([2]int{660, 1320}), Rating: 4.0},
}
```

- [ ] **Step 4: 跑綠**

```bash
go test ./... -run 'TestOpening|TestMock'
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): places provider interface with mock taipei dataset"
```

---

### Task 4: 引擎 — 硬性過濾

預估 45 分鐘。

**Files:**
- Create: `server/weights.go`
- Create: `server/engine.go`
- Test: `server/engine_test.go`

**Interfaces:**
- Consumes: Task 3 的 `Restaurant`、`OpeningHours`
- Produces:

```go
type Member struct {
	UserID       string
	BudgetMax    int
	Cuisines     []string
	Dietary      []string
	MaxDistanceM int
	Transport    string
}
type TraceEntry struct {
	Factor string  `json:"factor"`
	Mult   float64 `json:"mult"`
	Reason string  `json:"reason"`
}
type Candidate struct {
	Restaurant
	Score       float64
	Probability float64
	Trace       []TraceEntry
}
type Excluded struct {
	Restaurant
	Kind   string // "dietary" | "budget" | "closed"
	Reason string
}
type EngineInput struct {
	Restaurants          []Restaurant
	Members              []Member
	Now                  time.Time
	CenterLat, CenterLng float64
}
type EngineResult struct {
	Kept     []Candidate
	Excluded []Excluded
}
func Evaluate(in EngineInput) EngineResult
```

Task 5 擴充計分；Task 7 直接呼叫 `Evaluate`。

- [ ] **Step 1: 寫失敗測試（table-driven）**

`server/engine_test.go`：

```go
package main

import (
	"strings"
	"testing"
	"time"
)

var lunchMonday = at(time.Monday, 12, 0) // 沿用 places_test.go 的 at()

func member(over func(*Member)) Member {
	m := Member{UserID: "u1", BudgetMax: 500, Cuisines: []string{"japanese"},
		MaxDistanceM: 2000, Transport: "walking"}
	if over != nil {
		over(&m)
	}
	return m
}

func rest(over func(*Restaurant)) Restaurant {
	r := Restaurant{PlaceID: "p1", Name: "測試餐廳", CuisineTags: []string{"japanese"},
		PriceLevel: 1, Lat: 25.0480, Lng: 121.5172, Hours: daily([2]int{0, 1440})}
	if over != nil {
		over(&r)
	}
	return r
}

func TestHardFilters(t *testing.T) {
	cases := []struct {
		name       string
		r          Restaurant
		ms         []Member
		wantKind   string // "" = 應保留
		wantReason string
	}{
		{"全部通過", rest(nil), []Member{member(nil)}, "", ""},
		{"素食成員排除火鍋", rest(func(r *Restaurant) { r.CuisineTags = []string{"hotpot"} }),
			[]Member{member(func(m *Member) { m.Dietary = []string{"vegetarian"} })},
			"dietary", "vegetarian"},
		{"價位超過最低預算", rest(func(r *Restaurant) { r.PriceLevel = 4 }),
			[]Member{member(nil), member(func(m *Member) { m.UserID = "u2"; m.BudgetMax = 200 })},
			"budget", "NT$"},
		{"未營業", rest(func(r *Restaurant) { r.Hours = daily([2]int{330, 660}) }),
			[]Member{member(nil)}, "closed", "未營業"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			res := Evaluate(EngineInput{Restaurants: []Restaurant{c.r}, Members: c.ms,
				Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170})
			if c.wantKind == "" {
				if len(res.Kept) != 1 {
					t.Fatalf("應保留，got excluded %+v", res.Excluded)
				}
				return
			}
			if len(res.Excluded) != 1 {
				t.Fatalf("應排除，got kept %+v", res.Kept)
			}
			e := res.Excluded[0]
			if e.Kind != c.wantKind || !strings.Contains(e.Reason, c.wantReason) {
				t.Errorf("want kind=%s reason 含 %q，got %s %q", c.wantKind, c.wantReason, e.Kind, e.Reason)
			}
		})
	}
}
```

- [ ] **Step 2: 跑紅**

```bash
go test ./... -run TestHardFilters
```

Expected: FAIL（`Evaluate` undefined）。

- [ ] **Step 3: 實作 weights.go 與 engine.go（本 task 只做硬過濾；計分因素 Task 5 補上）**

`server/weights.go`：

```go
package main

// 所有可調參數集中此檔（spec §5）

var PriceLevelMaxTWD = map[int]int{0: 100, 1: 200, 2: 400, 3: 800, 4: 1600}

// tag 層級禁忌 → 衝突的餐廳 tag（ADR-0001：不含過敏原判定）
var DietaryConflicts = map[string][]string{
	"vegetarian": {"bbq", "steak", "hotpot", "seafood", "fried_chicken", "beef_noodle", "ramen"},
	"no_beef":    {"steak", "beef_noodle"},
	"no_pork":    {"ramen", "dimsum"},
	"halal":      {"ramen", "dimsum", "bbq", "hotpot", "fried_chicken"},
}

var DietaryLabels = map[string]string{
	"vegetarian": "素食", "no_beef": "不吃牛", "no_pork": "不吃豬", "halal": "清真",
}

var TransportMetersPerMin = map[string]float64{"walking": 75, "driving": 500, "transit": 200}

const (
	PrefMultMin = 0.6
	PrefMultMax = 1.5

	DistMultBest  = 1.2
	DistMultWorst = 0.7
	DistBestMin   = 5.0  // ≤5 分鐘 → DistMultBest
	DistWorstMin  = 25.0 // ≥25 分鐘 → DistMultWorst

	ClosingSoonMinutes = 60
	ClosingSoonMult    = 0.6
)
```

`server/engine.go`：

```go
package main

import (
	"fmt"
	"time"
)

type Member struct {
	UserID       string
	BudgetMax    int
	Cuisines     []string
	Dietary      []string
	MaxDistanceM int
	Transport    string
}

type TraceEntry struct {
	Factor string  `json:"factor"`
	Mult   float64 `json:"mult"`
	Reason string  `json:"reason"`
}

type Candidate struct {
	Restaurant
	Score       float64
	Probability float64
	Trace       []TraceEntry
}

type Excluded struct {
	Restaurant
	Kind   string
	Reason string
}

type EngineInput struct {
	Restaurants          []Restaurant
	Members              []Member
	Now                  time.Time
	CenterLat, CenterLng float64
}

type EngineResult struct {
	Kept     []Candidate
	Excluded []Excluded
}

func hasTag(tags []string, want string) bool {
	for _, t := range tags {
		if t == want {
			return true
		}
	}
	return false
}

func hardExclude(r Restaurant, ms []Member, now time.Time) (kind, reason string) {
	for _, m := range ms {
		for _, d := range m.Dietary {
			for _, conflict := range DietaryConflicts[d] {
				if hasTag(r.CuisineTags, conflict) {
					return "dietary", fmt.Sprintf("類型「%s」與成員飲食禁忌（%s，vegetarian 標記為 %s）衝突",
						conflict, DietaryLabels[d], d)
				}
			}
		}
	}
	minBudget := ms[0].BudgetMax
	for _, m := range ms[1:] {
		if m.BudgetMax < minBudget {
			minBudget = m.BudgetMax
		}
	}
	if price := PriceLevelMaxTWD[r.PriceLevel]; price > minBudget {
		return "budget", fmt.Sprintf("價位約 NT$%d，超過成員預算上限 NT$%d", price, minBudget)
	}
	if !r.Hours.IsOpenAt(now) {
		return "closed", "目前未營業"
	}
	return "", ""
}

func Evaluate(in EngineInput) EngineResult {
	var res EngineResult
	for _, r := range in.Restaurants {
		if kind, reason := hardExclude(r, in.Members, in.Now); kind != "" {
			res.Excluded = append(res.Excluded, Excluded{r, kind, reason})
			continue
		}
		c := Candidate{Restaurant: r, Score: 1.0}
		res.Kept = append(res.Kept, c)
	}
	normalize(res.Kept)
	return res
}

func normalize(kept []Candidate) {
	var sum float64
	for i := range kept {
		sum += kept[i].Score
	}
	if sum == 0 {
		return
	}
	for i := range kept {
		kept[i].Probability = kept[i].Score / sum
	}
}
```

- [ ] **Step 4: 跑綠**

```bash
go test ./... -run TestHardFilters
```

Expected: PASS。

注意：dietary 的 reason 需含英文 tag 名（測試檢查 `vegetarian` 字串）— 上面 fmt 已包含。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): engine hard filters with chinese exclusion reasons"
```

---

### Task 5: 引擎 — 計分因素 + 正規化 + trace

預估 60 分鐘。

**Files:**
- Modify: `server/engine.go`（`Evaluate` 內加入因素迴圈）
- Test: `server/engine_test.go`（新增測試）

**Interfaces:**
- Consumes: Task 4 全部型別
- Produces: `Evaluate` 完整版 — 每個 kept candidate 有 `Trace`（factor 值固定為 `"preference"`、`"distance"`、`"closing_soon"`）、`Score`、`Probability`（總和 = 1）。Task 6/7 與前端 chips 依賴這三個 factor 字串。

- [ ] **Step 1: 寫失敗測試**

加到 `server/engine_test.go`：

```go
func TestScoringFactors(t *testing.T) {
	rJP := rest(func(r *Restaurant) { r.PlaceID = "jp"; r.CuisineTags = []string{"japanese"} })
	rKR := rest(func(r *Restaurant) { r.PlaceID = "kr"; r.CuisineTags = []string{"korean"} })
	ms := []Member{
		member(nil), // 偏好 japanese
		member(func(m *Member) { m.UserID = "u2"; m.Cuisines = []string{"japanese", "korean"} }),
	}
	res := Evaluate(EngineInput{Restaurants: []Restaurant{rJP, rKR}, Members: ms,
		Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170})
	if len(res.Kept) != 2 {
		t.Fatalf("應保留 2 家，got %d", len(res.Kept))
	}
	byID := map[string]Candidate{}
	for _, c := range res.Kept {
		byID[c.PlaceID] = c
	}
	if !(byID["jp"].Score > byID["kr"].Score) {
		t.Errorf("2/2 命中的日式應高於 1/2 命中的韓式：%f vs %f", byID["jp"].Score, byID["kr"].Score)
	}
	var sum float64
	for _, c := range res.Kept {
		sum += c.Probability
		if len(c.Trace) != 3 {
			t.Errorf("%s trace 應有 3 個因素，got %d", c.PlaceID, len(c.Trace))
		}
		for _, e := range c.Trace {
			if e.Reason == "" || e.Mult <= 0 {
				t.Errorf("trace 不完整: %+v", e)
			}
		}
	}
	if sum < 0.9999 || sum > 1.0001 {
		t.Errorf("機率總和應為 1，got %f", sum)
	}
}

func TestClosingSoonDemoted(t *testing.T) {
	soon := rest(func(r *Restaurant) { r.PlaceID = "soon"; r.Hours = daily([2]int{0, 750}) })  // 12:30 打烊
	late := rest(func(r *Restaurant) { r.PlaceID = "late"; r.Hours = daily([2]int{0, 1440}) })
	res := Evaluate(EngineInput{Restaurants: []Restaurant{soon, late},
		Members: []Member{member(nil)}, Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170})
	byID := map[string]Candidate{}
	for _, c := range res.Kept {
		byID[c.PlaceID] = c
	}
	want := byID["late"].Score * ClosingSoonMult
	got := byID["soon"].Score
	if got < want-0.0001 || got > want+0.0001 {
		t.Errorf("即將打烊應 ×%.1f：got %f want %f", ClosingSoonMult, got, want)
	}
}
```

- [ ] **Step 2: 跑紅**

```bash
go test ./... -run 'TestScoring|TestClosingSoon'
```

Expected: FAIL（trace 為空、分數相同）。

- [ ] **Step 3: 實作因素**

在 `server/engine.go` 加入，並把 `Evaluate` 的 kept 段改為跑因素迴圈：

```go
type factorFn func(r Restaurant, in EngineInput) TraceEntry

func prefFactor(r Restaurant, in EngineInput) TraceEntry {
	hits := 0
	for _, m := range in.Members {
		for _, c := range m.Cuisines {
			if hasTag(r.CuisineTags, c) {
				hits++
				break
			}
		}
	}
	ratio := float64(hits) / float64(len(in.Members))
	mult := PrefMultMin + (PrefMultMax-PrefMultMin)*ratio
	return TraceEntry{"preference", mult,
		fmt.Sprintf("%d/%d 位成員偏好命中", hits, len(in.Members))}
}

func distFactor(r Restaurant, in EngineInput) TraceEntry {
	dist := Haversine(in.CenterLat, in.CenterLng, r.Lat, r.Lng)
	var sumMult, sumMin float64
	for _, m := range in.Members {
		minutes := dist / TransportMetersPerMin[m.Transport]
		frac := (minutes - DistBestMin) / (DistWorstMin - DistBestMin)
		if frac < 0 {
			frac = 0
		}
		if frac > 1 {
			frac = 1
		}
		sumMult += DistMultBest + (DistMultWorst-DistMultBest)*frac
		sumMin += minutes
	}
	n := float64(len(in.Members))
	return TraceEntry{"distance", sumMult / n,
		fmt.Sprintf("平均交通約 %.0f 分鐘", sumMin/n)}
}

func closingFactor(r Restaurant, in EngineInput) TraceEntry {
	left := r.Hours.MinutesUntilClose(in.Now)
	if left >= 0 && left < ClosingSoonMinutes {
		return TraceEntry{"closing_soon", ClosingSoonMult,
			fmt.Sprintf("%d 分鐘後打烊", left)}
	}
	return TraceEntry{"closing_soon", 1.0, "營業時間充裕"}
}

var factors = []factorFn{prefFactor, distFactor, closingFactor}
```

`Evaluate` 中 kept 段改為：

```go
		c := Candidate{Restaurant: r, Score: 1.0}
		for _, f := range factors {
			e := f(r, in)
			c.Score *= e.Mult
			c.Trace = append(c.Trace, e)
		}
		res.Kept = append(res.Kept, c)
```

- [ ] **Step 4: 跑綠（全部引擎測試）**

```bash
go test ./... -run 'TestHardFilters|TestScoring|TestClosingSoon'
```

Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): scoring factors, normalization and explanation trace"
```

---

### Task 6: 加權抽選 — Draw / Replay + 統計測試

預估 45 分鐘。

**Files:**
- Create: `server/draw.go`
- Test: `server/draw_test.go`

**Interfaces:**
- Consumes: Task 4/5 的 `Candidate`
- Produces:

```go
func Draw(kept []Candidate) (winnerRestaurantKey, seedHex string)
func ReplayWinner(kept []Candidate, seedHex string) string
// winnerRestaurantKey = Candidate.Restaurant.ID（DB uuid）；ID 為空時退回 PlaceID（純測試場景）
```

Task 7 呼叫 `Draw` 並把 `seedHex` 存進 `draws.seed`。

- [ ] **Step 1: 寫失敗測試**

`server/draw_test.go`：

```go
package main

import (
	"math"
	"testing"
)

func cands(ps ...float64) []Candidate {
	out := make([]Candidate, len(ps))
	for i, p := range ps {
		out[i] = Candidate{Restaurant: Restaurant{PlaceID: string(rune('a' + i))}, Probability: p}
	}
	return out
}

func TestDrawReplayDeterministic(t *testing.T) {
	ks := cands(0.5, 0.3, 0.2)
	winner, seed := Draw(ks)
	if seed == "" {
		t.Fatal("seed 不可為空")
	}
	for i := 0; i < 10; i++ {
		if got := ReplayWinner(ks, seed); got != winner {
			t.Fatalf("replay 不一致：%s vs %s", got, winner)
		}
	}
}

func TestDrawDistribution(t *testing.T) {
	ks := cands(0.5, 0.3, 0.2)
	counts := map[string]int{}
	const n = 100000
	for i := 0; i < n; i++ {
		w, _ := Draw(ks)
		counts[w]++
	}
	for i, want := range []float64{0.5, 0.3, 0.2} {
		got := float64(counts[string(rune('a'+i))]) / n
		if math.Abs(got-want) > 0.015 {
			t.Errorf("候選 %c：期望 %.2f，實際 %.4f", 'a'+i, want, got)
		}
	}
}
```

- [ ] **Step 2: 跑紅**

```bash
go test ./... -run TestDraw
```

Expected: FAIL（`Draw` undefined）。

- [ ] **Step 3: 實作**

`server/draw.go`：

```go
package main

import (
	crand "crypto/rand"
	"encoding/binary"
	"encoding/hex"
	mrand "math/rand/v2"
	"sort"
)

func candKey(c Candidate) string {
	if c.Restaurant.ID != "" {
		return c.Restaurant.ID
	}
	return c.PlaceID
}

// Draw 以 crypto/rand 產生 seed，再用可重放的 PRNG 抽出 winner（spec §2 抽選可信度：seed 留存）
func Draw(kept []Candidate) (string, string) {
	var b [8]byte
	if _, err := crand.Read(b[:]); err != nil {
		panic(err) // 系統熵源失效屬致命錯誤
	}
	seedHex := hex.EncodeToString(b[:])
	return ReplayWinner(kept, seedHex), seedHex
}

func ReplayWinner(kept []Candidate, seedHex string) string {
	b, err := hex.DecodeString(seedHex)
	if err != nil || len(b) != 8 {
		return ""
	}
	sorted := append([]Candidate{}, kept...)
	sort.Slice(sorted, func(i, j int) bool { return candKey(sorted[i]) < candKey(sorted[j]) })
	rng := mrand.New(mrand.NewPCG(binary.LittleEndian.Uint64(b), 0))
	x := rng.Float64()
	cum := 0.0
	for _, c := range sorted {
		cum += c.Probability
		if x < cum {
			return candKey(c)
		}
	}
	return candKey(sorted[len(sorted)-1]) // 浮點誤差保底
}
```

- [ ] **Step 4: 跑綠**

```bash
go test ./... -run TestDraw
```

Expected: PASS（分佈測試容差 ±1.5%）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(server): seeded weighted draw with replay and distribution test"
```

---

### Task 7: DB 層 + `/search`、`/draw` handlers

預估 90–120 分鐘。

**Files:**
- Create: `server/db.go`
- Create: `server/handlers.go`
- Modify: `server/main.go`（掛路由）
- Test: `server/handlers_test.go`

**Interfaces:**
- Consumes: Task 1 schema、Task 2 `Verifier`/`UserID`、Task 3 `PlacesProvider`、Task 5 `Evaluate`、Task 6 `Draw`
- Produces:
  - `POST /api/rooms/{id}/search`（房主）→ 200 `{"kept":[{"restaurant_id","name","probability","trace":[{factor,mult,reason}]}],"excluded":[{"name","reason"}]}`；非房主 403；狀態不對 409；零候選 422 `{"error":"no_candidates","excluded":[...],"excluded_by":{"dietary":n,"budget":n,"closed":n}}`
  - `POST /api/rooms/{id}/draw`（房主）→ 200 `{"winner_restaurant_id","seed"}`；同樣的 403/409 規則
  - 環境變數 `SUPABASE_DB_URL`
  - 前端（Task 11/12）依賴這些 route 與 JSON 欄位名

- [ ] **Step 1: 寫測試（純 auth 部分不用 DB；流程測試 gated by `TEST_DATABASE_URL`）**

`server/handlers_test.go`：

```go
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newTestApp(t *testing.T, pool *pgxpool.Pool) http.Handler {
	t.Setenv("SUPABASE_JWT_SECRET", "test-secret-test-secret-test-secret!")
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	return buildRoutes(v, pool, NewMockProvider())
}

func TestSearchRequiresAuth(t *testing.T) {
	h := newTestApp(t, nil)
	r := httptest.NewRequest("POST", "/api/rooms/00000000-0000-0000-0000-000000000001/search", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 got %d", w.Code)
	}
}

func TestSearchAndDrawHappyPath(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	hostID := "11111111-1111-1111-1111-111111111111"
	roomID := "22222222-2222-2222-2222-222222222222"
	_, err = pool.Exec(ctx, `
		insert into auth.users (id, email) values ($1, 'host@test.dev') on conflict do nothing;
		`, hostID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		 values ($1, $2, 500, '["japanese"]', 2000, 'walking') on conflict do nothing`,
		roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})

	h := newTestApp(t, pool)
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	do := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	w1 := do(fmt.Sprintf("/api/rooms/%s/search", roomID))
	if w1.Code != http.StatusOK {
		t.Fatalf("search: want 200 got %d body %s", w1.Code, w1.Body.String())
	}
	var sr struct {
		Kept []struct {
			RestaurantID string       `json:"restaurant_id"`
			Probability  float64      `json:"probability"`
			Trace        []TraceEntry `json:"trace"`
		} `json:"kept"`
	}
	if err := json.Unmarshal(w1.Body.Bytes(), &sr); err != nil || len(sr.Kept) == 0 {
		t.Fatalf("search 應回非空 kept：%v %s", err, w1.Body.String())
	}

	if w := do(fmt.Sprintf("/api/rooms/%s/search", roomID)); w.Code != http.StatusConflict {
		t.Fatalf("重複 search: want 409 got %d", w.Code)
	}

	w2 := do(fmt.Sprintf("/api/rooms/%s/draw", roomID))
	if w2.Code != http.StatusOK {
		t.Fatalf("draw: want 200 got %d body %s", w2.Code, w2.Body.String())
	}
	var dr struct {
		Winner string `json:"winner_restaurant_id"`
		Seed   string `json:"seed"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &dr); err != nil || dr.Winner == "" || dr.Seed == "" {
		t.Fatalf("draw 回應不完整：%s", w2.Body.String())
	}
	if w := do(fmt.Sprintf("/api/rooms/%s/draw", roomID)); w.Code != http.StatusConflict {
		t.Fatalf("重複 draw: want 409 got %d", w.Code)
	}
}
```

- [ ] **Step 2: 跑紅**

```bash
go get github.com/jackc/pgx/v5 && go test ./... -run 'TestSearchRequires'
```

Expected: FAIL（`buildRoutes` undefined）。

- [ ] **Step 3: 實作 db.go**

`server/db.go`：

```go
package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

var ErrConflict = errors.New("status conflict")

type RoomRow struct {
	ID        string
	HostID    string
	Status    string
	CenterLat float64
	CenterLng float64
}

func LoadRoom(ctx context.Context, pool *pgxpool.Pool, roomID string) (RoomRow, error) {
	var r RoomRow
	err := pool.QueryRow(ctx,
		`select id, host_id, status, coalesce(center_lat, 0), coalesce(center_lng, 0)
		 from rooms where id = $1`, roomID).
		Scan(&r.ID, &r.HostID, &r.Status, &r.CenterLat, &r.CenterLng)
	return r, err
}

func LoadMembers(ctx context.Context, pool *pgxpool.Pool, roomID string) ([]Member, error) {
	rows, err := pool.Query(ctx,
		`select user_id, budget_max, cuisines, dietary, max_distance_m, transport
		 from room_members where room_id = $1`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Member
	for rows.Next() {
		var m Member
		var cuisines, dietary []byte
		if err := rows.Scan(&m.UserID, &m.BudgetMax, &cuisines, &dietary,
			&m.MaxDistanceM, &m.Transport); err != nil {
			return nil, err
		}
		json.Unmarshal(cuisines, &m.Cuisines)
		json.Unmarshal(dietary, &m.Dietary)
		out = append(out, m)
	}
	return out, rows.Err()
}

// UpsertRestaurants 寫入快取並回填 DB uuid 到 rs[i].ID
func UpsertRestaurants(ctx context.Context, tx pgx.Tx, rs []Restaurant) error {
	for i := range rs {
		tags, _ := json.Marshal(rs[i].CuisineTags)
		hours, _ := json.Marshal(rs[i].Hours)
		err := tx.QueryRow(ctx, `
			insert into restaurants (place_id, name, cuisine_tags, price_level, lat, lng, address, opening_hours, rating, fetched_at)
			values ($1, $2, $3, $4, $5, $6, $7, $8, $9, now())
			on conflict (place_id) do update set
			  name = excluded.name, cuisine_tags = excluded.cuisine_tags,
			  price_level = excluded.price_level, lat = excluded.lat, lng = excluded.lng,
			  address = excluded.address, opening_hours = excluded.opening_hours,
			  rating = excluded.rating, fetched_at = now()
			returning id`,
			rs[i].PlaceID, rs[i].Name, tags, rs[i].PriceLevel, rs[i].Lat, rs[i].Lng,
			rs[i].Address, hours, rs[i].Rating).Scan(&rs[i].ID)
		if err != nil {
			return fmt.Errorf("upsert %s: %w", rs[i].PlaceID, err)
		}
	}
	return nil
}

func ReplaceCandidates(ctx context.Context, tx pgx.Tx, roomID string, res EngineResult) error {
	if _, err := tx.Exec(ctx, `delete from room_candidates where room_id = $1`, roomID); err != nil {
		return err
	}
	for _, c := range res.Kept {
		trace, _ := json.Marshal(c.Trace)
		if _, err := tx.Exec(ctx, `
			insert into room_candidates (room_id, restaurant_id, status, probability, weight_breakdown)
			values ($1, $2, 'kept', $3, $4)`,
			roomID, c.Restaurant.ID, c.Probability, trace); err != nil {
			return err
		}
	}
	for _, e := range res.Excluded {
		if _, err := tx.Exec(ctx, `
			insert into room_candidates (room_id, restaurant_id, status, exclusion_reason)
			values ($1, $2, 'excluded', $3)`,
			roomID, e.Restaurant.ID, e.Reason); err != nil {
			return err
		}
	}
	return nil
}

func TransitionRoom(ctx context.Context, tx pgx.Tx, roomID, from, to string) error {
	tag, err := tx.Exec(ctx,
		`update rooms set status = $3 where id = $1 and status = $2`, roomID, from, to)
	if err != nil {
		return err
	}
	if tag.RowsAffected() == 0 {
		return ErrConflict
	}
	return nil
}

func LoadKeptCandidates(ctx context.Context, pool *pgxpool.Pool, roomID string) ([]Candidate, error) {
	rows, err := pool.Query(ctx, `
		select rc.restaurant_id, rc.probability, r.name
		from room_candidates rc join restaurants r on r.id = rc.restaurant_id
		where rc.room_id = $1 and rc.status = 'kept'`, roomID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var out []Candidate
	for rows.Next() {
		var c Candidate
		if err := rows.Scan(&c.Restaurant.ID, &c.Probability, &c.Restaurant.Name); err != nil {
			return nil, err
		}
		out = append(out, c)
	}
	return out, rows.Err()
}
```

- [ ] **Step 4: 實作 handlers.go 並改 main.go**

`server/handlers.go`：

```go
package main

import (
	"context"
	"errors"
	"net/http"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func buildRoutes(v *Verifier, pool *pgxpool.Pool, places PlacesProvider) http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, map[string]bool{"ok": true})
	})
	api := http.NewServeMux()
	api.HandleFunc("POST /api/rooms/{id}/search", func(w http.ResponseWriter, r *http.Request) {
		handleSearch(w, r, pool, places)
	})
	api.HandleFunc("POST /api/rooms/{id}/draw", func(w http.ResponseWriter, r *http.Request) {
		handleDraw(w, r, pool)
	})
	mux.Handle("/api/", v.Middleware(api))
	return cors(mux)
}

// loadHostRoom 驗證房主身分並回房間；非房主回 403、找不到回 404
func loadHostRoom(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) (RoomRow, bool) {
	room, err := LoadRoom(r.Context(), pool, r.PathValue("id"))
	if err != nil {
		jsonError(w, http.StatusNotFound, "房間不存在")
		return room, false
	}
	if room.HostID != UserID(r) {
		jsonError(w, http.StatusForbidden, "只有房主可以執行此操作")
		return room, false
	}
	return room, true
}

type keptJSON struct {
	RestaurantID string       `json:"restaurant_id"`
	Name         string       `json:"name"`
	Probability  float64      `json:"probability"`
	Trace        []TraceEntry `json:"trace"`
}

type excludedJSON struct {
	Name   string `json:"name"`
	Reason string `json:"reason"`
}

func handleSearch(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, places PlacesProvider) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	members, err := LoadMembers(ctx, pool, room.ID)
	if err != nil || len(members) == 0 {
		jsonError(w, http.StatusInternalServerError, "讀取成員失敗")
		return
	}
	radius := members[0].MaxDistanceM
	for _, m := range members[1:] {
		if m.MaxDistanceM < radius {
			radius = m.MaxDistanceM
		}
	}
	found, err := places.SearchNearby(ctx, room.CenterLat, room.CenterLng, radius)
	if err != nil {
		jsonError(w, http.StatusBadGateway, "餐廳搜尋失敗")
		return
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		jsonError(w, http.StatusInternalServerError, "db error")
		return
	}
	defer tx.Rollback(ctx)
	if err := UpsertRestaurants(ctx, tx, found); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入餐廳快取失敗")
		return
	}
	result := Evaluate(EngineInput{Restaurants: found, Members: members,
		Now: time.Now(), CenterLat: room.CenterLat, CenterLng: room.CenterLng})

	if len(result.Kept) == 0 {
		byKind := map[string]int{}
		var ex []excludedJSON
		for _, e := range result.Excluded {
			byKind[e.Kind]++
			ex = append(ex, excludedJSON{e.Name, e.Reason})
		}
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusUnprocessableEntity)
		jsonOK(w, map[string]any{"error": "no_candidates", "excluded": ex, "excluded_by": byKind})
		return
	}
	if err := ReplaceCandidates(ctx, tx, room.ID, result); err != nil {
		jsonError(w, http.StatusInternalServerError, "寫入候選失敗")
		return
	}
	if err := TransitionRoom(ctx, tx, room.ID, "lobby", "candidates"); err != nil {
		if errors.Is(err, ErrConflict) {
			jsonError(w, http.StatusConflict, "房間狀態已變更")
			return
		}
		jsonError(w, http.StatusInternalServerError, "db error")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		jsonError(w, http.StatusInternalServerError, "db error")
		return
	}
	var kept []keptJSON
	for _, c := range result.Kept {
		kept = append(kept, keptJSON{c.Restaurant.ID, c.Name, c.Probability, c.Trace})
	}
	var ex []excludedJSON
	for _, e := range result.Excluded {
		ex = append(ex, excludedJSON{e.Name, e.Reason})
	}
	jsonOK(w, map[string]any{"kept": kept, "excluded": ex})
}

func handleDraw(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	kept, err := LoadKeptCandidates(ctx, pool, room.ID)
	if err != nil || len(kept) == 0 {
		jsonError(w, http.StatusConflict, "沒有可抽選的候選")
		return
	}
	winner, seed := Draw(kept)
	probs := map[string]float64{}
	for _, c := range kept {
		probs[c.Restaurant.ID] = c.Probability
	}
	if err := insertDrawTx(ctx, pool, room.ID, winner, seed, probs); err != nil {
		if errors.Is(err, ErrConflict) {
			jsonError(w, http.StatusConflict, "已抽選過")
			return
		}
		jsonError(w, http.StatusInternalServerError, "db error")
		return
	}
	jsonOK(w, map[string]string{"winner_restaurant_id": winner, "seed": seed})
}

func insertDrawTx(ctx context.Context, pool *pgxpool.Pool, roomID, winner, seed string,
	probs map[string]float64) error {
	tx, err := pool.Begin(ctx)
	if err != nil {
		return err
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx,
		`insert into draws (room_id, seed, winner_restaurant_id, probabilities)
		 values ($1, $2, $3, $4)`, roomID, seed, winner, probs); err != nil {
		return err
	}
	if err := TransitionRoom(ctx, tx, roomID, "candidates", "decided"); err != nil {
		return err
	}
	return tx.Commit(ctx)
}
```

`server/main.go` 的 `main()` 改為：

```go
func main() {
	verifier, err := NewVerifier()
	if err != nil {
		log.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), os.Getenv("SUPABASE_DB_URL"))
	if err != nil {
		log.Fatal(err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8787"
	}
	log.Printf("listening on :%s", port)
	log.Fatal(http.ListenAndServe(":"+port, buildRoutes(verifier, pool, NewMockProvider())))
}
```

（同步把 `main.go` 的 import 補上 `context`、`github.com/jackc/pgx/v5/pgxpool`，移除不再用的 `fmt`。）

- [ ] **Step 5: 跑綠（含 integration）**

```bash
go test ./... -run TestSearchRequires
```

```bash
TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' go test ./... -run TestSearchAndDraw -v
```

Expected: 兩者 PASS（integration 需 `supabase start` 執行中）。

- [ ] **Step 6: Commit**

```bash
git add -A && git commit -m "feat(server): search and draw handlers with conditional transitions"
```

---

### Task 8: Web 骨架 + Auth 頁

預估 60 分鐘。

**Files:**
- Create: `web/`（Vite 模板）
- Create: `web/.env.local`
- Create: `web/src/lib/supabase.ts`
- Create: `web/src/lib/types.ts`
- Create: `web/src/pages/AuthPage.tsx`
- Modify: `web/src/App.tsx`、`web/src/main.tsx`、`web/src/index.css`、`web/vite.config.ts`

**Interfaces:**
- Consumes: Task 1 的 Supabase local stack
- Produces: `supabase` client 單例、`useSession()`、route 結構 `/auth`、`/`、`/room/:id`；`types.ts` 的 `Room`/`MemberRow`/`CandidateRow`/`TraceEntry`/`DrawRow`。Task 9–12 都 import 這些。

- [ ] **Step 1: 建立專案與依賴**

```bash
cd D:/app && npm create vite@latest web -- --template react-ts && cd web && npm i @supabase/supabase-js react-router-dom && npm i -D tailwindcss @tailwindcss/vite vitest
```

`web/vite.config.ts`：

```ts
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

export default defineConfig({
  plugins: [react(), tailwindcss()],
})
```

`web/src/index.css` 全檔改為：

```css
@import "tailwindcss";
```

`web/.env.local`（值取自 `supabase start` 的輸出）：

```
VITE_SUPABASE_URL=http://127.0.0.1:54321
VITE_SUPABASE_ANON_KEY=<supabase start 輸出的 anon key>
VITE_API_URL=http://localhost:8787
```

- [ ] **Step 2: lib 與型別**

`web/src/lib/supabase.ts`：

```ts
import { createClient } from '@supabase/supabase-js'

export const supabase = createClient(
  import.meta.env.VITE_SUPABASE_URL,
  import.meta.env.VITE_SUPABASE_ANON_KEY,
)
```

`web/src/lib/types.ts`：

```ts
export type TraceEntry = { factor: string; mult: number; reason: string }

export type Room = {
  id: string
  code: string
  host_id: string
  status: 'lobby' | 'candidates' | 'decided'
  center_lat: number
  center_lng: number
  exploration: 'familiar' | 'balanced' | 'explore'
}

export type MemberRow = {
  room_id: string
  user_id: string
  budget_max: number
  cuisines: string[]
  dietary: string[]
  max_distance_m: number
  transport: 'walking' | 'driving' | 'transit'
  ready: boolean
  profiles?: { display_name: string }
}

export type RestaurantRef = {
  name: string
  lat: number
  lng: number
  place_id: string
}

export type CandidateRow = {
  room_id: string
  restaurant_id: string
  status: 'kept' | 'excluded'
  probability: number | null
  weight_breakdown: TraceEntry[]
  exclusion_reason: string | null
  restaurants: RestaurantRef
}

export type DrawRow = {
  room_id: string
  winner_restaurant_id: string
  seed: string
  probabilities: Record<string, number>
}
```

- [ ] **Step 3: Auth 頁與路由**

`web/src/pages/AuthPage.tsx`：

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

export default function AuthPage() {
  const nav = useNavigate()
  const [mode, setMode] = useState<'login' | 'register'>('login')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [displayName, setDisplayName] = useState('')
  const [error, setError] = useState('')

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const { error } =
      mode === 'register'
        ? await supabase.auth.signUp({
            email,
            password,
            options: { data: { display_name: displayName } },
          })
        : await supabase.auth.signInWithPassword({ email, password })
    if (error) setError(error.message)
    else nav('/')
  }

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-4 p-4">
      <h1 className="text-2xl font-bold">今天吃什麼</h1>
      <form onSubmit={submit} className="space-y-3">
        {mode === 'register' && (
          <input className="w-full rounded border p-2" placeholder="顯示名稱"
            value={displayName} onChange={e => setDisplayName(e.target.value)} required />
        )}
        <input className="w-full rounded border p-2" type="email" placeholder="Email"
          value={email} onChange={e => setEmail(e.target.value)} required />
        <input className="w-full rounded border p-2" type="password" placeholder="密碼（至少 6 碼）"
          value={password} onChange={e => setPassword(e.target.value)} required minLength={6} />
        {error && <p className="text-sm text-red-600">{error}</p>}
        <button className="w-full rounded bg-orange-500 p-2 text-white" type="submit">
          {mode === 'login' ? '登入' : '註冊'}
        </button>
      </form>
      <button className="text-sm text-gray-500 underline"
        onClick={() => setMode(mode === 'login' ? 'register' : 'login')}>
        {mode === 'login' ? '沒有帳號？註冊' : '已有帳號？登入'}
      </button>
    </div>
  )
}
```

`web/src/App.tsx` 全檔改為：

```tsx
import { useEffect, useState } from 'react'
import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom'
import type { Session } from '@supabase/supabase-js'
import { supabase } from './lib/supabase'
import AuthPage from './pages/AuthPage'

export function useSession() {
  const [session, setSession] = useState<Session | null>(null)
  const [loading, setLoading] = useState(true)
  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => {
      setSession(data.session)
      setLoading(false)
    })
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setSession(s))
    return () => sub.subscription.unsubscribe()
  }, [])
  return { session, loading }
}

function Guard({ children }: { children: React.ReactNode }) {
  const { session, loading } = useSession()
  if (loading) return <p className="p-8 text-center">載入中…</p>
  if (!session) return <Navigate to="/auth" replace />
  return <>{children}</>
}

export default function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/auth" element={<AuthPage />} />
        <Route path="/" element={<Guard><p className="p-8">首頁（Task 9）</p></Guard>} />
        <Route path="/room/:id" element={<Guard><p className="p-8">房間（Task 10）</p></Guard>} />
      </Routes>
    </BrowserRouter>
  )
}
```

- [ ] **Step 4: 驗證**

```bash
cd D:/app/web && npm run build
```

Expected: build 成功。再手動：`npm run dev` → 開 `http://localhost:5173` → 註冊帳號 → 導向首頁 placeholder；Supabase Studio（`http://127.0.0.1:54323`）確認 `profiles` 自動建了一列、`display_name` 正確。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): vite scaffold, auth page and route guard"
```

---

### Task 9: 首頁 — 建房 / 邀請碼加入

預估 45 分鐘。

**Files:**
- Create: `web/src/pages/HomePage.tsx`
- Modify: `web/src/App.tsx`（換掉首頁 placeholder）

**Interfaces:**
- Consumes: Task 1 的 `create_room`/`join_room` RPC、Task 8 的 `supabase`
- Produces: 建房後導向 `/room/:id`；房間頁由 Task 10 實作

- [ ] **Step 1: 實作 HomePage**

`web/src/pages/HomePage.tsx`：

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { supabase } from '../lib/supabase'

const FALLBACK = { lat: 25.0478, lng: 121.517 } // 台北車站：拒絕定位時的 demo 預設

function getPosition(): Promise<{ lat: number; lng: number }> {
  return new Promise(resolve => {
    if (!navigator.geolocation) return resolve(FALLBACK)
    navigator.geolocation.getCurrentPosition(
      p => resolve({ lat: p.coords.latitude, lng: p.coords.longitude }),
      () => resolve(FALLBACK),
      { timeout: 5000 },
    )
  })
}

export default function HomePage() {
  const nav = useNavigate()
  const [code, setCode] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function createRoom() {
    setBusy(true)
    setError('')
    const pos = await getPosition()
    const { data, error } = await supabase.rpc('create_room', {
      p_lat: pos.lat, p_lng: pos.lng,
    })
    setBusy(false)
    if (error) setError(error.message)
    else nav(`/room/${data}`)
  }

  async function joinRoom(e: React.FormEvent) {
    e.preventDefault()
    setError('')
    const { data, error } = await supabase.rpc('join_room', { p_code: code })
    if (error) setError('房間不存在或已開始')
    else nav(`/room/${data}`)
  }

  return (
    <div className="mx-auto mt-16 max-w-sm space-y-6 p-4">
      <h1 className="text-2xl font-bold">今天吃什麼</h1>
      <button onClick={createRoom} disabled={busy}
        className="w-full rounded bg-orange-500 p-3 text-white disabled:opacity-50">
        {busy ? '定位中…' : '建立房間'}
      </button>
      <form onSubmit={joinRoom} className="flex gap-2">
        <input className="flex-1 rounded border p-2 uppercase" placeholder="邀請碼"
          value={code} onChange={e => setCode(e.target.value)} required maxLength={6} />
        <button className="rounded bg-gray-800 px-4 text-white" type="submit">加入</button>
      </form>
      {error && <p className="text-sm text-red-600">{error}</p>}
      <button className="text-sm text-gray-500 underline"
        onClick={() => supabase.auth.signOut()}>登出</button>
    </div>
  )
}
```

`web/src/App.tsx`：import `HomePage` 並把 `/` route 換成 `<Guard><HomePage /></Guard>`。

- [ ] **Step 2: 驗證**

```bash
npm run build
```

手動：登入 → 建立房間 → URL 變 `/room/<uuid>`；Studio 看 `rooms` 有列、`code` 為 6 碼、`room_members` 有房主。第二個瀏覽器（無痕）註冊另一帳號 → 輸入邀請碼 → 進同一房。錯誤碼輸入 → 顯示「房間不存在或已開始」。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(web): home page with create room and join by code"
```

---

### Task 10: 房間 lobby — 條件表單 + ready + realtime 成員列表

預估 90 分鐘。

**Files:**
- Create: `web/src/hooks/useRoom.ts`
- Create: `web/src/components/ConditionsForm.tsx`
- Create: `web/src/pages/RoomPage.tsx`
- Modify: `web/src/App.tsx`（掛 RoomPage）

**Interfaces:**
- Consumes: Task 8 types、Task 1 realtime publication 與 RLS
- Produces: `useRoom(roomId)` 回 `{ room, members, candidates, draw, myUserId, refetch }`；Task 11/12 直接使用。`ConditionsForm` 寫 `room_members` 自己的列。

- [ ] **Step 1: useRoom hook**

`web/src/hooks/useRoom.ts`：

```ts
import { useCallback, useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { CandidateRow, DrawRow, MemberRow, Room } from '../lib/types'

export function useRoom(roomId: string) {
  const [room, setRoom] = useState<Room | null>(null)
  const [members, setMembers] = useState<MemberRow[]>([])
  const [candidates, setCandidates] = useState<CandidateRow[]>([])
  const [draw, setDraw] = useState<DrawRow | null>(null)
  const [myUserId, setMyUserId] = useState('')

  const refetch = useCallback(async () => {
    const [r, m, c, d] = await Promise.all([
      supabase.from('rooms').select('*').eq('id', roomId).single(),
      supabase.from('room_members').select('*, profiles(display_name)').eq('room_id', roomId),
      supabase.from('room_candidates')
        .select('*, restaurants(name, lat, lng, place_id)').eq('room_id', roomId),
      supabase.from('draws').select('*').eq('room_id', roomId).maybeSingle(),
    ])
    if (r.data) setRoom(r.data as Room)
    setMembers((m.data ?? []) as MemberRow[])
    setCandidates((c.data ?? []) as CandidateRow[])
    setDraw((d.data ?? null) as DrawRow | null)
  }, [roomId])

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => setMyUserId(data.user?.id ?? ''))
    refetch()
    // ponytail: 任何相關表變更就整包重抓，P1 資料量小；量大再改增量更新
    const tables = [
      { table: 'rooms', filter: `id=eq.${roomId}` },
      { table: 'room_members', filter: `room_id=eq.${roomId}` },
      { table: 'room_candidates', filter: `room_id=eq.${roomId}` },
      { table: 'draws', filter: `room_id=eq.${roomId}` },
    ]
    let ch = supabase.channel(`room-${roomId}`)
    for (const t of tables) {
      ch = ch.on('postgres_changes',
        { event: '*', schema: 'public', table: t.table, filter: t.filter }, refetch)
    }
    ch.subscribe()
    return () => { supabase.removeChannel(ch) }
  }, [roomId, refetch])

  return { room, members, candidates, draw, myUserId, refetch }
}
```

- [ ] **Step 2: 條件表單**

`web/src/components/ConditionsForm.tsx`：

```tsx
import { useEffect, useState } from 'react'
import { supabase } from '../lib/supabase'
import type { MemberRow } from '../lib/types'

export const CUISINE_OPTIONS: [string, string][] = [
  ['taiwanese', '台式'], ['japanese', '日式'], ['korean', '韓式'],
  ['cantonese', '港式'], ['western', '西式'], ['indian', '印度'],
  ['sichuan', '川味'], ['hotpot', '火鍋'], ['seafood', '海鮮'], ['ramen', '拉麵'],
]
export const DIETARY_OPTIONS: [string, string][] = [
  ['vegetarian', '素食'], ['no_beef', '不吃牛'], ['no_pork', '不吃豬'], ['halal', '清真'],
]
const TRANSPORTS: [MemberRow['transport'], string][] = [
  ['walking', '步行'], ['driving', '開車'], ['transit', '大眾運輸'],
]

export default function ConditionsForm({ me }: { me: MemberRow }) {
  const [form, setForm] = useState(me)
  useEffect(() => setForm(me), [me.room_id, me.user_id])

  async function save(patch: Partial<MemberRow>) {
    const next = { ...form, ...patch }
    setForm(next)
    await supabase.from('room_members').update({
      budget_max: next.budget_max,
      cuisines: next.cuisines,
      dietary: next.dietary,
      max_distance_m: next.max_distance_m,
      transport: next.transport,
      ready: next.ready,
    }).eq('room_id', me.room_id).eq('user_id', me.user_id)
  }

  function toggle(list: string[], v: string) {
    return list.includes(v) ? list.filter(x => x !== v) : [...list, v]
  }

  return (
    <div className="space-y-4 rounded border p-4">
      <label className="block">
        <span className="text-sm text-gray-600">每人預算上限 NT${form.budget_max}</span>
        <input type="range" min={100} max={1600} step={100} className="w-full"
          value={form.budget_max}
          onChange={e => save({ budget_max: +e.target.value })} />
      </label>
      <div>
        <span className="text-sm text-gray-600">料理偏好</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {CUISINE_OPTIONS.map(([v, label]) => (
            <button key={v} type="button"
              className={`rounded-full border px-3 py-1 text-sm ${form.cuisines.includes(v) ? 'bg-orange-500 text-white' : ''}`}
              onClick={() => save({ cuisines: toggle(form.cuisines, v) })}>{label}</button>
          ))}
        </div>
      </div>
      <div>
        <span className="text-sm text-gray-600">飲食禁忌</span>
        <div className="mt-1 flex flex-wrap gap-2">
          {DIETARY_OPTIONS.map(([v, label]) => (
            <button key={v} type="button"
              className={`rounded-full border px-3 py-1 text-sm ${form.dietary.includes(v) ? 'bg-red-500 text-white' : ''}`}
              onClick={() => save({ dietary: toggle(form.dietary, v) })}>{label}</button>
          ))}
        </div>
      </div>
      <label className="block">
        <span className="text-sm text-gray-600">可接受距離 {form.max_distance_m} 公尺</span>
        <input type="range" min={300} max={3000} step={100} className="w-full"
          value={form.max_distance_m}
          onChange={e => save({ max_distance_m: +e.target.value })} />
      </label>
      <div className="flex gap-2">
        {TRANSPORTS.map(([v, label]) => (
          <button key={v} type="button"
            className={`rounded border px-3 py-1 text-sm ${form.transport === v ? 'bg-gray-800 text-white' : ''}`}
            onClick={() => save({ transport: v })}>{label}</button>
        ))}
      </div>
      <button type="button"
        className={`w-full rounded p-2 text-white ${form.ready ? 'bg-green-600' : 'bg-gray-400'}`}
        onClick={() => save({ ready: !form.ready })}>
        {form.ready ? '已準備 ✓（點擊取消）' : '我準備好了'}
      </button>
    </div>
  )
}
```

- [ ] **Step 3: RoomPage（lobby 視圖；candidates/decided 視圖由 Task 11/12 填入）**

`web/src/pages/RoomPage.tsx`：

```tsx
import { useParams } from 'react-router-dom'
import { useRoom } from '../hooks/useRoom'
import ConditionsForm from '../components/ConditionsForm'

export default function RoomPage() {
  const { id = '' } = useParams()
  const { room, members, candidates, draw, myUserId } = useRoom(id)
  if (!room) return <p className="p-8 text-center">載入中…</p>

  const me = members.find(m => m.user_id === myUserId)
  const isHost = room.host_id === myUserId

  return (
    <div className="mx-auto max-w-lg space-y-4 p-4">
      <header className="flex items-center justify-between">
        <h1 className="text-xl font-bold">房間 {room.code}</h1>
        <span className="text-sm text-gray-500">{
          { lobby: '等待中', candidates: '候選已出爐', decided: '已定案' }[room.status]
        }</span>
      </header>

      <section className="rounded border p-3">
        <h2 className="mb-2 text-sm text-gray-600">成員（{members.length}）</h2>
        <ul className="space-y-1">
          {members.map(m => (
            <li key={m.user_id} className="flex justify-between text-sm">
              <span>
                {m.profiles?.display_name ?? '成員'}
                {m.user_id === room.host_id && '（房主）'}
              </span>
              <span className={m.ready ? 'text-green-600' : 'text-gray-400'}>
                {m.ready ? '已準備' : '設定中'}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {room.status === 'lobby' && me && <ConditionsForm me={me} />}
      {room.status === 'lobby' && isHost && (
        <SearchButton roomId={room.id} />
      )}
      {/* Task 11: candidates 視圖；Task 12: 轉盤與結果 */}
      {room.status !== 'lobby' && (
        <p className="text-sm text-gray-500">候選 {candidates.length} 筆，draw：{draw ? '有' : '無'}</p>
      )}
    </div>
  )
}

export function SearchButton({ roomId }: { roomId: string }) {
  return (
    <button className="w-full rounded bg-orange-500 p-3 text-white"
      onClick={() => import('../lib/api').then(m => m.searchRoom(roomId))}>
      開始搜尋餐廳
    </button>
  )
}
```

`web/src/lib/api.ts`：

```ts
import { supabase } from './supabase'

async function post(path: string): Promise<Response> {
  const { data } = await supabase.auth.getSession()
  const token = data.session?.access_token ?? ''
  return fetch(`${import.meta.env.VITE_API_URL}${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
  })
}

export async function searchRoom(roomId: string) {
  const res = await post(`/api/rooms/${roomId}/search`)
  if (res.status === 422) {
    const body = await res.json()
    const by = Object.entries(body.excluded_by as Record<string, number>)
      .sort((a, b) => b[1] - a[1])
    const label: Record<string, string> = { budget: '預算', dietary: '飲食禁忌', closed: '營業時間' }
    alert(`找不到符合所有條件的餐廳。\n最主要原因：${label[by[0]?.[0]] ?? by[0]?.[0]}（排除 ${by[0]?.[1]} 家）。\n請放寬條件後再試。`)
  } else if (!res.ok) {
    alert(`搜尋失敗（${res.status}）`)
  }
}

export async function drawRoom(roomId: string) {
  const res = await post(`/api/rooms/${roomId}/draw`)
  if (!res.ok) alert(`抽選失敗（${res.status}）`)
}
```

`web/src/App.tsx`：import `RoomPage` 並把 `/room/:id` route 換成 `<Guard><RoomPage /></Guard>`。

- [ ] **Step 4: 驗證**

```bash
npm run build
```

手動雙瀏覽器：兩帳號進同房 → A 改條件、按 ready → B 畫面 1 秒內看到 ready 徽章變化（Realtime 生效）。啟動 Go（`SUPABASE_DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' SUPABASE_JWT_SECRET='<supabase status 顯示的 JWT secret>' go run ./server`）→ 房主按「開始搜尋餐廳」→ 兩邊同時看到狀態變「候選已出爐」與筆數。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): room lobby with conditions form and realtime member sync"
```

---

### Task 11: 候選清單 — 機率、加減權 chips、排除清單（vitest）

預估 60 分鐘。

**Files:**
- Create: `web/src/lib/probability.ts`
- Create: `web/src/lib/probability.test.ts`
- Create: `web/src/components/CandidateList.tsx`
- Modify: `web/src/pages/RoomPage.tsx`

**Interfaces:**
- Consumes: `CandidateRow`（Task 8）、`useRoom`（Task 10）
- Produces: `formatPercent(p: number): string`、`chipLabel(e: TraceEntry): string`、`FACTOR_LABELS`、`sortKept(rows: CandidateRow[]): CandidateRow[]`

- [ ] **Step 1: 寫失敗測試**

`web/src/lib/probability.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { chipLabel, formatPercent, sortKept } from './probability'
import type { CandidateRow } from './types'

const cand = (p: number | null, status: 'kept' | 'excluded' = 'kept'): CandidateRow => ({
  room_id: 'r', restaurant_id: String(p), status, probability: p,
  weight_breakdown: [], exclusion_reason: null,
  restaurants: { name: 'x', lat: 0, lng: 0, place_id: 'p' },
})

describe('formatPercent', () => {
  it('一般值取一位小數', () => expect(formatPercent(0.3121)).toBe('31.2%'))
  it('小於 1% 顯示 <1%', () => expect(formatPercent(0.004)).toBe('<1%'))
  it('1 顯示 100%', () => expect(formatPercent(1)).toBe('100.0%'))
})

describe('chipLabel', () => {
  it('加權顯示 ×值與理由', () =>
    expect(chipLabel({ factor: 'preference', mult: 1.3, reason: '3/4 位成員偏好命中' }))
      .toBe('偏好 ×1.30 · 3/4 位成員偏好命中'))
  it('未知 factor 用原名', () =>
    expect(chipLabel({ factor: 'mystery', mult: 1, reason: 'r' })).toContain('mystery'))
})

describe('sortKept', () => {
  it('依機率由高到低且只留 kept', () => {
    const rows = [cand(0.1), cand(0.5), cand(null, 'excluded'), cand(0.4)]
    expect(sortKept(rows).map(r => r.probability)).toEqual([0.5, 0.4, 0.1])
  })
})
```

- [ ] **Step 2: 跑紅**

`web/package.json` 的 scripts 加 `"test": "vitest run"`，然後：

```bash
npm test
```

Expected: FAIL（模組不存在）。

- [ ] **Step 3: 實作**

`web/src/lib/probability.ts`：

```ts
import type { CandidateRow, TraceEntry } from './types'

export const FACTOR_LABELS: Record<string, string> = {
  preference: '偏好',
  distance: '距離',
  closing_soon: '打烊',
}

export function formatPercent(p: number): string {
  if (p > 0 && p < 0.01) return '<1%'
  return `${(p * 100).toFixed(1)}%`
}

export function chipLabel(e: TraceEntry): string {
  const name = FACTOR_LABELS[e.factor] ?? e.factor
  return `${name} ×${e.mult.toFixed(2)} · ${e.reason}`
}

export function sortKept(rows: CandidateRow[]): CandidateRow[] {
  return rows
    .filter(r => r.status === 'kept')
    .sort((a, b) => (b.probability ?? 0) - (a.probability ?? 0))
}

export function sortExcluded(rows: CandidateRow[]): CandidateRow[] {
  return rows.filter(r => r.status === 'excluded')
}
```

`web/src/components/CandidateList.tsx`：

```tsx
import { useState } from 'react'
import type { CandidateRow } from '../lib/types'
import { chipLabel, formatPercent, sortExcluded, sortKept } from '../lib/probability'

export default function CandidateList({ rows }: { rows: CandidateRow[] }) {
  const [showExcluded, setShowExcluded] = useState(false)
  const kept = sortKept(rows)
  const excluded = sortExcluded(rows)

  return (
    <div className="space-y-3">
      {kept.map(c => (
        <div key={c.restaurant_id} className="rounded border p-3">
          <div className="flex justify-between">
            <span className="font-medium">{c.restaurants.name}</span>
            <span className="font-mono text-orange-600">
              {formatPercent(c.probability ?? 0)}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap gap-1">
            {c.weight_breakdown.map((e, i) => (
              <span key={i}
                className={`rounded-full px-2 py-0.5 text-xs ${e.mult > 1 ? 'bg-green-100 text-green-800' : e.mult < 1 ? 'bg-red-100 text-red-800' : 'bg-gray-100 text-gray-600'}`}>
                {chipLabel(e)}
              </span>
            ))}
          </div>
        </div>
      ))}
      {excluded.length > 0 && (
        <div>
          <button className="text-sm text-gray-500 underline"
            onClick={() => setShowExcluded(!showExcluded)}>
            {showExcluded ? '隱藏' : '顯示'}被排除的 {excluded.length} 家
          </button>
          {showExcluded && (
            <ul className="mt-2 space-y-1">
              {excluded.map(c => (
                <li key={c.restaurant_id} className="text-sm text-gray-500">
                  {c.restaurants.name} — {c.exclusion_reason}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  )
}
```

`web/src/pages/RoomPage.tsx`：把 `room.status !== 'lobby'` 的 placeholder 段換成：

```tsx
      {room.status === 'candidates' && (
        <>
          <CandidateList rows={candidates} />
          {isHost && (
            <button className="w-full rounded bg-orange-500 p-3 text-white"
              onClick={() => import('../lib/api').then(m => m.drawRoom(room.id))}>
              啟動轉盤
            </button>
          )}
        </>
      )}
```

（頂部 import `CandidateList`。）

- [ ] **Step 4: 跑綠 + build**

```bash
npm test && npm run build
```

Expected: vitest 全 PASS、build 成功。手動：搜尋後兩個瀏覽器都看到排序後的候選、% 與彩色 chips、可展開排除清單（例如晚餐時間會看到「早安美芝城 — 目前未營業」）。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): candidate list with probabilities and trace chips"
```

---

### Task 12: 轉盤動畫 + 結果卡 + Google Maps 跳轉

預估 90 分鐘。

**Files:**
- Create: `web/src/lib/maps.ts`
- Create: `web/src/components/Wheel.tsx`
- Create: `web/src/components/ResultCard.tsx`
- Modify: `web/src/pages/RoomPage.tsx`
- Test: `web/src/lib/maps.test.ts`

**Interfaces:**
- Consumes: `DrawRow`、`CandidateRow`、`sortKept`、成員自己的 `transport`
- Produces: `buildMapsUrl(lat, lng, placeId, transport): string`

- [ ] **Step 1: maps 測試（先紅後綠，小而快）**

`web/src/lib/maps.test.ts`：

```ts
import { describe, expect, it } from 'vitest'
import { buildMapsUrl } from './maps'

describe('buildMapsUrl', () => {
  it('組出正確的 dir URL 與 travelmode', () => {
    const url = buildMapsUrl(25.05, 121.52, 'abc123', 'transit')
    expect(url).toContain('https://www.google.com/maps/dir/?api=1')
    expect(url).toContain('destination=25.05%2C121.52')
    expect(url).toContain('destination_place_id=abc123')
    expect(url).toContain('travelmode=transit')
  })
})
```

`web/src/lib/maps.ts`：

```ts
export function buildMapsUrl(
  lat: number, lng: number, placeId: string,
  transport: 'walking' | 'driving' | 'transit',
): string {
  const q = new URLSearchParams({
    api: '1',
    destination: `${lat},${lng}`,
    destination_place_id: placeId,
    travelmode: transport,
  })
  return `https://www.google.com/maps/dir/?${q.toString()}`
}
```

```bash
npm test
```

Expected: PASS。

- [ ] **Step 2: Wheel 元件（SVG 圓餅 + CSS 旋轉；所有客戶端動畫終點一致）**

`web/src/components/Wheel.tsx`：

```tsx
import { useEffect, useMemo, useState } from 'react'
import type { CandidateRow } from '../lib/types'
import { formatPercent, sortKept } from '../lib/probability'

const COLORS = ['#f97316', '#0ea5e9', '#22c55e', '#eab308', '#a855f7',
  '#ef4444', '#14b8a6', '#f43f5e', '#8b5cf6', '#84cc16', '#06b6d4', '#d946ef']

function arcPath(cx: number, cy: number, r: number, a0: number, a1: number): string {
  const rad = (a: number) => ((a - 90) * Math.PI) / 180
  const x0 = cx + r * Math.cos(rad(a0)), y0 = cy + r * Math.sin(rad(a0))
  const x1 = cx + r * Math.cos(rad(a1)), y1 = cy + r * Math.sin(rad(a1))
  const large = a1 - a0 > 180 ? 1 : 0
  return `M ${cx} ${cy} L ${x0} ${y0} A ${r} ${r} 0 ${large} 1 ${x1} ${y1} Z`
}

export default function Wheel({ rows, winnerId, onDone }: {
  rows: CandidateRow[]
  winnerId: string | null
  onDone: () => void
}) {
  const kept = useMemo(() => sortKept(rows), [rows])
  const slices = useMemo(() => {
    let acc = 0
    return kept.map((c, i) => {
      const start = acc
      acc += (c.probability ?? 0) * 360
      return { c, start, end: acc, color: COLORS[i % COLORS.length] }
    })
  }, [kept])

  const [rotation, setRotation] = useState(0)
  useEffect(() => {
    if (!winnerId) return
    const s = slices.find(x => x.c.restaurant_id === winnerId)
    if (!s) return
    const center = (s.start + s.end) / 2
    setRotation(5 * 360 + (360 - center)) // 指針固定在 12 點鐘，轉輪本體旋轉
    const t = setTimeout(onDone, 4200)
    return () => clearTimeout(t)
  }, [winnerId, slices, onDone])

  return (
    <div className="relative mx-auto w-72">
      <div className="absolute -top-1 left-1/2 z-10 -translate-x-1/2 text-2xl">▼</div>
      <svg viewBox="0 0 200 200"
        style={{ transform: `rotate(${rotation}deg)`, transition: 'transform 4s cubic-bezier(0.2, 0.8, 0.2, 1)' }}>
        {slices.map(s => (
          <path key={s.c.restaurant_id} d={arcPath(100, 100, 98, s.start, s.end)}
            fill={s.color} stroke="white" strokeWidth="1" />
        ))}
      </svg>
      <ul className="mt-3 space-y-1 text-sm">
        {slices.map(s => (
          <li key={s.c.restaurant_id} className="flex items-center gap-2">
            <span className="inline-block h-3 w-3 rounded-sm" style={{ background: s.color }} />
            <span className="flex-1">{s.c.restaurants.name}</span>
            <span className="font-mono">{formatPercent(s.c.probability ?? 0)}</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
```

- [ ] **Step 3: ResultCard 與 RoomPage 整合**

`web/src/components/ResultCard.tsx`：

```tsx
import type { CandidateRow, DrawRow, MemberRow } from '../lib/types'
import { buildMapsUrl } from '../lib/maps'
import { formatPercent } from '../lib/probability'

export default function ResultCard({ draw, candidates, me }: {
  draw: DrawRow
  candidates: CandidateRow[]
  me: MemberRow | undefined
}) {
  const winner = candidates.find(c => c.restaurant_id === draw.winner_restaurant_id)
  if (!winner) return null
  const r = winner.restaurants
  const prob = draw.probabilities[draw.winner_restaurant_id] ?? 0
  return (
    <div className="space-y-3 rounded border-2 border-orange-500 p-4 text-center">
      <p className="text-sm text-gray-500">今天就吃</p>
      <h2 className="text-2xl font-bold">{r.name}</h2>
      <p className="text-sm text-gray-500">抽中機率 {formatPercent(prob)}</p>
      <a className="block rounded bg-blue-600 p-3 text-white"
        href={buildMapsUrl(r.lat, r.lng, r.place_id, me?.transport ?? 'walking')}
        target="_blank" rel="noreferrer">
        用 Google Maps 導航（{{ walking: '步行', driving: '開車', transit: '大眾運輸' }[me?.transport ?? 'walking']}）
      </a>
    </div>
  )
}
```

`web/src/pages/RoomPage.tsx`：加 `import { useState } from 'react'`、`Wheel`、`ResultCard`，並把 decided 邏輯接上（`candidates` 視圖不變，新增）：

```tsx
  const [spinning, setSpinning] = useState(false)
  const [spun, setSpun] = useState(false)

  useEffect(() => {
    if (draw && !spun) setSpinning(true)
  }, [draw, spun])
```

```tsx
      {room.status === 'decided' && draw && (
        spinning && !spun ? (
          <Wheel rows={candidates} winnerId={draw.winner_restaurant_id}
            onDone={() => { setSpun(true); setSpinning(false) }} />
        ) : (
          <ResultCard draw={draw} candidates={candidates} me={me} />
        )
      )}
```

（`useEffect` 需从 react import；`draw` 由 realtime 送達時所有成員同時開始轉。）

- [ ] **Step 4: 驗證**

```bash
npm test && npm run build
```

手動雙瀏覽器完整閉環：建房 → 兩人設條件 → 搜尋 → 候選與機率 → 房主啟動轉盤 → **兩邊同時**播放旋轉動畫且停在同一家 → 結果卡 → 點導航開啟 Google Maps 且 travelmode 是自己設的交通方式。再按一次 draw API（重整後房主按鈕已消失，用 curl 驗證）→ 409。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "feat(web): synchronized wheel animation, result card and maps handoff"
```

---

### Task 13: README + demo script + 完整驗證

預估 30 分鐘。

**Files:**
- Create: `README.md`
- Create: `docs/demo-script.md`

**Interfaces:**
- Consumes: 前面全部
- Produces: 一鍵可跟的啟動與 demo 步驟

- [ ] **Step 1: README**

寫入 `README.md`：

```markdown
# 今天吃什麼 — 多人餐廳決策與公平抽選

多人房間 + 條件過濾 + 加權可解釋機率 + 伺服器抽選。設計文件見
`docs/superpowers/specs/2026-08-05-group-restaurant-decision-app-design.md`，
詞彙表見 `CONTEXT.md`，決策紀錄見 `docs/adr/`。

## 本地啟動（三個終端）

```bash
# 1. Supabase local stack
supabase start        # 記下 anon key 與 JWT secret

# 2. Go 核心服務
cd server
SUPABASE_DB_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' \
SUPABASE_JWT_SECRET='<supabase status 的 JWT secret>' \
go run .

# 3. Web
cd web && npm i && npm run dev   # .env.local 填 anon key
```

## 測試

```bash
supabase test db                                   # RLS pgTAP
cd server && go test ./...                         # 引擎/抽選/auth
cd server && TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:54322/postgres' go test ./... -run TestSearchAndDraw -v
cd web && npm test                                 # 機率顯示與 maps URL
```

Phase 1 使用 mock 餐廳資料（台北車站周邊 12 家）；真實 Google Places 於 Phase 2 切換。
```

- [ ] **Step 2: demo script**

寫入 `docs/demo-script.md`：

```markdown
# Demo script（雙瀏覽器，約 3 分鐘）

1. 瀏覽器 A：註冊「小明」→ 建立房間 → 唸出邀請碼
2. 瀏覽器 B（無痕）：註冊「小華」→ 輸入邀請碼加入
3. A：預算 800、偏好日式+火鍋、步行、800m、ready
4. B：預算 400、偏好台式、**素食**、步行、800m、ready
   （重點：B 的素食會硬排除火鍋/燒肉類，B 的 400 預算會排除高價位）
5. A 按「開始搜尋餐廳」→ 兩邊同時出現候選清單
6. 指出畫面重點：每家的機率 %、綠色加權 chips、紅色降權 chips、
   展開「被排除的 N 家」唸排除原因（例：價位超過預算上限）
7. A 按「啟動轉盤」→ 兩邊同步旋轉、停在同一家
8. 結果卡 → 點「用 Google Maps 導航」→ 開啟 Maps 且交通方式正確
9. （選）打開 Supabase Studio 看 draws.seed 與機率快照 — 抽選留有紀錄
```

- [ ] **Step 3: 全套驗證**

依 README 測試小節跑完四組指令，全綠後：

```bash
git add -A && git commit -m "docs: readme and demo script for phase 1"
```

Expected: Phase 1 閉環完成 — 這就是 spec §11 Phase 1 的全部範圍。

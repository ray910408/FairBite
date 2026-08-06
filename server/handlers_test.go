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
	"golang.org/x/time/rate"
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
	// 先註冊 = 後執行（Cleanup 為 LIFO）：確保下方刪 room 的 cleanup 在 pool 關閉前跑完，
	// 否則 delete 打在已關閉的 pool 上被靜默丟棄，殘留的 draws 列會讓下次執行的 draw 直接 409
	t.Cleanup(func() { pool.Close() })

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

func TestRateLimit429(t *testing.T) {
	h := rateLimit(&limiterStore{m: map[string]*rate.Limiter{}},
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	last := 0
	for i := 0; i < RateLimitBurst+1; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/x", nil))
		last = w.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("第 %d 個連發請求應 429，got %d", RateLimitBurst+1, last)
	}
}

func TestSearchEdgeCases(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// 先註冊 = 後執行（Cleanup 為 LIFO）：確保下方刪 room 的 cleanup 在 pool 關閉前跑完，
	// 否則 delete 打在已關閉的 pool 上被靜默丟棄，殘留的 draws 列會讓下次執行的 draw 直接 409
	t.Cleanup(func() { pool.Close() })

	hostID := "33333333-3333-3333-3333-333333333333"
	strangerID := "44444444-4444-4444-4444-444444444444"
	roomID := "55555555-5555-5555-5555-555555555555"
	if _, err = pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'host2@test.dev') on conflict do nothing`,
		hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	// budget_max=50：所有 price level 換算金額都 >50 → 全數排除 → 422
	if _, err = pool.Exec(ctx,
		`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		 values ($1, $2, 50, '["japanese"]', 2000, 'walking')
		 on conflict (room_id, user_id) do update set budget_max = 50`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID) })

	h := newTestApp(t, pool)
	do := func(token, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	hostTok := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	strangerTok := signHS256(t, "test-secret-test-secret-test-secret!", strangerID)

	if w := do(strangerTok, "/api/rooms/"+roomID+"/search"); w.Code != http.StatusForbidden {
		t.Fatalf("非房主 search: want 403 got %d", w.Code)
	}
	if w := do(strangerTok, "/api/rooms/66666666-6666-6666-6666-666666666666/search"); w.Code != http.StatusNotFound {
		t.Fatalf("不存在的房: want 404 got %d", w.Code)
	}
	w := do(hostTok, "/api/rooms/"+roomID+"/search")
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("全排除: want 422 got %d body %s", w.Code, w.Body.String())
	}
	var body struct {
		ExcludedBy map[string]int `json:"excluded_by"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.ExcludedBy["budget"] == 0 {
		t.Fatalf("422 應含 excluded_by.budget 統計：%s", w.Body.String())
	}
	var status string
	if err := pool.QueryRow(ctx, `select status from public.rooms where id = $1`, roomID).
		Scan(&status); err != nil || status != "lobby" {
		t.Fatalf("零候選後房間應停留在 lobby，got %q err %v", status, err)
	}
}

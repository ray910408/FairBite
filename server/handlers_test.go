package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newTestApp(t *testing.T, pool *pgxpool.Pool) http.Handler {
	t.Setenv("SUPABASE_JWT_SECRET", "test-secret-test-secret-test-secret!")
	t.Setenv("SUPABASE_JWKS_URL", "") // 外部環境設了就會誤走 JWKS 路徑，HS256 測試必失敗
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	return buildRoutes(v, pool, NewMockProvider(), newLimiterStore(1000, 1000))
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
	if w := do("/api/rooms/" + roomID + "/start-voting"); w.Code != http.StatusOK {
		t.Fatalf("start-voting: want 200 got %d body %s", w.Code, w.Body.String())
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
	h := rateLimit(newLimiterStore(RateLimitPerSec, RateLimitBurst),
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

func TestSearchDrawRecordsHistory(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "77777777-7777-7777-7777-777777777777"
	roomID := "88888888-8888-8888-8888-888888888888"
	if _, err = pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'hist@test.dev') on conflict do nothing`,
		hostID); err != nil {
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
		pool.Exec(ctx, `delete from public.dining_history where room_id = $1`, roomID)
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
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

	if w := do("/api/rooms/" + roomID + "/search"); w.Code != http.StatusOK {
		t.Fatalf("search: want 200 got %d body %s", w.Code, w.Body.String())
	}
	var recommended int
	if err := pool.QueryRow(ctx,
		`select count(*) from public.exposure_stats
		 where user_id = $1 and recommended_count > 0`, hostID).Scan(&recommended); err != nil {
		t.Fatal(err)
	}
	if recommended == 0 {
		t.Fatal("search 後 exposure_stats.recommended_count 應有紀錄")
	}
	if w := do("/api/rooms/" + roomID + "/start-voting"); w.Code != http.StatusOK {
		t.Fatalf("start-voting: want 200 got %d body %s", w.Code, w.Body.String())
	}

	if w := do("/api/rooms/" + roomID + "/draw"); w.Code != http.StatusOK {
		t.Fatalf("draw: want 200 got %d body %s", w.Code, w.Body.String())
	}
	var histCount, chosenCount int
	if err := pool.QueryRow(ctx,
		`select count(*) from public.dining_history where room_id = $1 and user_id = $2`,
		roomID, hostID).Scan(&histCount); err != nil {
		t.Fatal(err)
	}
	if histCount != 1 {
		t.Fatalf("draw 後每位成員應有 1 筆同席紀錄，got %d", histCount)
	}
	if err := pool.QueryRow(ctx,
		`select count(*) from public.exposure_stats
		 where user_id = $1 and chosen_count > 0 and last_chosen_at is not null`,
		hostID).Scan(&chosenCount); err != nil {
		t.Fatal(err)
	}
	if chosenCount != 1 {
		t.Fatalf("draw 後 winner 的 chosen_count 應 +1，got %d", chosenCount)
	}
}

func TestLoadRecencyBuckets(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	u1 := "99999999-9999-9999-9999-999999999999"
	u2 := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	u3 := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	r1 := "cccccccc-cccc-cccc-cccc-cccccccccccc"
	roomIDs := []string{
		"dddddddd-dddd-dddd-dddd-dddddddddddd",
		"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
		"ffffffff-ffff-ffff-ffff-ffffffffffff",
		"12121212-1212-1212-1212-121212121212",
	}

	if _, err = pool.Exec(ctx, `
		insert into auth.users (id, email) values
		  ($1, 'recency-u1@test.dev'),
		  ($2, 'recency-u2@test.dev'),
		  ($3, 'recency-u3@test.dev')
		on conflict do nothing`, u1, u2, u3); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		insert into public.restaurants (id, place_id, name, lat, lng)
		values ($1, 'recency-r1', 'Recency R1', 25.0478, 121.5170)
		on conflict (id) do nothing`, r1); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		insert into public.rooms (id, host_id, status) values
		  ($1, $5, 'decided'),
		  ($2, $5, 'decided'),
		  ($3, $5, 'decided'),
		  ($4, $5, 'decided')
		on conflict (id) do nothing`, roomIDs[0], roomIDs[1], roomIDs[2], roomIDs[3], u1); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.dining_history where room_id = any($1::uuid[])`, roomIDs)
		pool.Exec(ctx, `delete from public.rooms where id = any($1::uuid[])`, roomIDs)
		pool.Exec(ctx, `delete from public.restaurants where id = $1`, r1)
		pool.Exec(ctx, `delete from auth.users where id = any($1::uuid[])`, []string{u1, u2, u3})
	})

	if _, err = pool.Exec(ctx, `
		insert into public.dining_history (user_id, restaurant_id, room_id, decided_at) values
		  ($1, $4, $5, now() - interval '10 days'),
		  ($2, $4, $6, now() - interval '20 days'),
		  ($3, $4, $7, now() - interval '40 days'),
		  ($1, $4, $8, now() - interval '25 days')`,
		u1, u2, u3, r1, roomIDs[0], roomIDs[1], roomIDs[2], roomIDs[3]); err != nil {
		t.Fatal(err)
	}

	got, err := LoadRecency(ctx, pool, []string{u1, u2, u3}, []string{r1})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[r1].Fresh != 1 || got[r1].Fading != 1 {
		t.Fatalf("LoadRecency = %#v, want map[%s:{Fresh:1 Fading:1}]", got, r1)
	}
}

func TestVotingFlow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	memberID := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	strangerID := "cccccccc-cccc-cccc-cccc-cccccccccccc"
	roomID := "dddddddd-dddd-dddd-dddd-dddddddddddd"
	if _, err = pool.Exec(ctx, `
		insert into auth.users (id, email) values
		  ($1, 'vhost@test.dev'), ($2, 'vmember@test.dev'), ($3, 'vstranger@test.dev')
		on conflict do nothing`, hostID, memberID, strangerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{hostID, memberID} {
		if _, err = pool.Exec(ctx,
			`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
			 values ($1, $2, 500, '["japanese"]', 2000, 'walking') on conflict do nothing`,
			roomID, uid); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.dining_history where room_id = $1`, roomID)
		pool.Exec(ctx, `delete from public.exposure_stats where user_id in ($1, $2)`, hostID, memberID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})

	h := newTestApp(t, pool)
	do := func(uid, path, body string) *httptest.ResponseRecorder {
		var rd io.Reader
		if body != "" {
			rd = strings.NewReader(body)
		}
		r := httptest.NewRequest("POST", path, rd)
		r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", uid))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	vote := func(uid, rid, kind, op string) *httptest.ResponseRecorder {
		return do(uid, "/api/rooms/"+roomID+"/vote",
			fmt.Sprintf(`{"restaurant_id":%q,"kind":%q,"op":%q}`, rid, kind, op))
	}
	myVotes := func(kind string) int {
		var n int
		if err := pool.QueryRow(ctx, `select count(*) from public.votes
			where room_id = $1 and user_id = $2 and kind = $3`,
			roomID, memberID, kind).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// vote 在 voting 前不可用；start-voting 僅房主
	if w := do(hostID, "/api/rooms/"+roomID+"/search", ""); w.Code != http.StatusOK {
		t.Fatalf("search: %d %s", w.Code, w.Body.String())
	}
	// 只取 kept：excluded 列無 weight_breakdown，且 uuid 排序在每次 reset 間隨機
	var cands []string
	rows, err := pool.Query(ctx, `select restaurant_id from public.room_candidates
		where room_id = $1 and status = 'kept' order by restaurant_id`, roomID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		cands = append(cands, id)
	}
	rows.Close()
	if len(cands) < 4 {
		t.Fatalf("測試需要至少 4 家候選，got %d", len(cands))
	}
	if w := vote(memberID, cands[0], "up", "cast"); w.Code != http.StatusConflict {
		t.Fatalf("candidates 階段 vote: want 409 got %d", w.Code)
	}
	if w := do(memberID, "/api/rooms/"+roomID+"/start-voting", ""); w.Code != http.StatusForbidden {
		t.Fatalf("非房主 start-voting: want 403 got %d", w.Code)
	}
	if w := do(hostID, "/api/rooms/"+roomID+"/start-voting", ""); w.Code != http.StatusOK {
		t.Fatalf("start-voting: %d %s", w.Code, w.Body.String())
	}
	if w := do(hostID, "/api/rooms/"+roomID+"/start-voting", ""); w.Code != http.StatusConflict {
		t.Fatalf("重複 start-voting: want 409 got %d", w.Code)
	}

	// cast up：成功 + 冪等（重複 cast 不變）；trace 出現投票因素
	if w := vote(memberID, cands[0], "up", "cast"); w.Code != http.StatusOK {
		t.Fatalf("vote up: %d %s", w.Code, w.Body.String())
	}
	if w := vote(memberID, cands[0], "up", "cast"); w.Code != http.StatusOK || myVotes("up") != 1 {
		t.Fatalf("重複 cast 應冪等：%d，up=%d", w.Code, myVotes("up"))
	}
	var trace string
	if err := pool.QueryRow(ctx,
		`select weight_breakdown::text from public.room_candidates
		 where room_id = $1 and restaurant_id = $2`, roomID, cands[0]).Scan(&trace); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(trace, `"votes"`) || !strings.Contains(trace, "1 張贊成票") {
		t.Fatalf("vote 後 trace 應含投票因素：%s", trace)
	}

	// 互斥：同店 cast veto → up 自動撤
	if w := vote(memberID, cands[0], "veto", "cast"); w.Code != http.StatusOK {
		t.Fatalf("veto: %d %s", w.Code, w.Body.String())
	}
	if myVotes("up") != 0 || myVotes("veto") != 1 {
		t.Fatalf("互斥失敗：up=%d veto=%d", myVotes("up"), myVotes("veto"))
	}

	// 限額：第 2 個否決 OK、第 3 個（他店）409；收回後釋放
	if w := vote(memberID, cands[1], "veto", "cast"); w.Code != http.StatusOK {
		t.Fatalf("第 2 個否決: %d %s", w.Code, w.Body.String())
	}
	w3 := vote(memberID, cands[2], "veto", "cast")
	if w3.Code != http.StatusConflict || !strings.Contains(w3.Body.String(), "否決額度已用完") {
		t.Fatalf("第 3 個否決應 409 含額度訊息：%d %s", w3.Code, w3.Body.String())
	}
	if w := vote(memberID, cands[0], "veto", "retract"); w.Code != http.StatusOK {
		t.Fatalf("收回: %d %s", w.Code, w.Body.String())
	}
	if w := vote(memberID, cands[0], "veto", "retract"); w.Code != http.StatusOK {
		t.Fatalf("重複收回應冪等: %d", w.Code)
	}
	if w := vote(memberID, cands[2], "veto", "cast"); w.Code != http.StatusOK {
		t.Fatalf("收回後額度應釋放: %d %s", w.Code, w.Body.String())
	}

	// 非成員 403；不在候選名單的餐廳 422
	if w := vote(strangerID, cands[0], "up", "cast"); w.Code != http.StatusForbidden {
		t.Fatalf("非成員 vote: want 403 got %d", w.Code)
	}
	if w := vote(memberID, "00000000-0000-0000-0000-00000000dead", "up", "cast"); w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "不在本房的候選名單中") {
		t.Fatalf("非候選餐廳 vote: want 422 with message got %d %s", w.Code, w.Body.String())
	}

	// 全否決前先清掉 member 的否決（host 無票）→ draw 從 voting 出發
	if _, err := pool.Exec(ctx,
		`delete from public.votes where room_id = $1`, roomID); err != nil {
		t.Fatal(err)
	}
	if w := do(hostID, "/api/rooms/"+roomID+"/draw", ""); w.Code != http.StatusOK {
		t.Fatalf("draw: %d %s", w.Code, w.Body.String())
	}

	// D7：decided 後 vote 應 409（條件鎖擋晚到的投票）
	if w := vote(memberID, cands[0], "up", "cast"); w.Code != http.StatusConflict {
		t.Fatalf("decided 後 vote: want 409 got %d", w.Code)
	}
}

func TestDrawAllVetoed(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "13131313-1313-1313-1313-131313131313"
	memberID := "14141414-1414-1414-1414-141414141414"
	roomID := "15151515-1515-1515-1515-151515151515"
	if _, err = pool.Exec(ctx, `
		insert into auth.users (id, email) values
		  ($1, 'veto-host@test.dev'), ($2, 'veto-member@test.dev')
		on conflict do nothing`, hostID, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{hostID, memberID} {
		if _, err = pool.Exec(ctx,
			`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
			 values ($1, $2, 500, '["japanese"]', 2000, 'walking') on conflict do nothing`,
			roomID, uid); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.dining_history where room_id = $1`, roomID)
		pool.Exec(ctx, `delete from public.exposure_stats where user_id in ($1, $2)`, hostID, memberID)
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
	if w := do("/api/rooms/" + roomID + "/search"); w.Code != http.StatusOK {
		t.Fatalf("search: want 200 got %d body %s", w.Code, w.Body.String())
	}
	if w := do("/api/rooms/" + roomID + "/start-voting"); w.Code != http.StatusOK {
		t.Fatalf("start-voting: want 200 got %d body %s", w.Code, w.Body.String())
	}

	rows, err := pool.Query(ctx, `select restaurant_id from public.room_candidates
		where room_id = $1 and status = 'kept' order by restaurant_id`, roomID)
	if err != nil {
		t.Fatal(err)
	}
	var kept []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		kept = append(kept, id)
	}
	rows.Close()
	if len(kept) == 0 {
		t.Fatal("測試需要至少 1 家 kept 候選")
	}
	for i, rid := range kept {
		uid := hostID
		if i%2 == 1 {
			uid = memberID
		}
		if _, err := pool.Exec(ctx, `insert into public.votes (room_id, user_id, restaurant_id, kind)
			values ($1, $2, $3, 'veto')`, roomID, uid, rid); err != nil {
			t.Fatal(err)
		}
	}

	w := do("/api/rooms/" + roomID + "/draw")
	if w.Code != http.StatusConflict ||
		!strings.Contains(w.Body.String(), "候選已全數被否決，請成員收回否決後再抽選") {
		t.Fatalf("全否決 draw 應 409 且有專用訊息：%d %s", w.Code, w.Body.String())
	}
}

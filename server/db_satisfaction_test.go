package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLoadSatisfactionRatingOverridesPrefHit(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const uid = "a8a8a8a8-a8a8-a8a8-a8a8-a8a8a8a8a8a8"
	var rid string
	t.Cleanup(func() {
		// 順序（OV#15）：rooms.host_id → profiles 無 cascade，先刪 rooms 再刪 user
		//（user cascade 清 dining_history），最後才刪得動被 FK 參照的餐廳
		pool.Exec(context.Background(), `delete from rooms where host_id = $1`, uid)
		pool.Exec(context.Background(), `delete from auth.users where id = $1`, uid)
		pool.Exec(context.Background(), `delete from restaurants where place_id = 'test-satisfaction-1'`)
	})
	if _, err := pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'sat@test.dev')`, uid); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into restaurants (place_id, name, lat, lng) values ('test-satisfaction-1', '滿足度測試', 25, 121)
		 returning id`).Scan(&rid); err != nil {
		t.Fatal(err)
	}
	// 兩筆不同房的紀錄（room_id 各自獨立以避開 unique(room_id, user_id)）：
	// 舊：pref_hit 1.0、無評分 → 樣本 1.0
	// 新：pref_hit 1.0、評 1 星 → rating 優先 → 樣本 (1-1)/4 = 0.0
	// EMA（由舊到新）= 0.3*0 + 0.7*1 = 0.7
	if _, err := pool.Exec(ctx, `
		with r1 as (insert into rooms (host_id) values ($1) returning id),
		     r2 as (insert into rooms (host_id) values ($1) returning id)
		insert into dining_history (user_id, restaurant_id, room_id, decided_at, pref_hit, rating)
		values ($1, $2, (select id from r1), now() - interval '2 days', 1.0, null),
		       ($1, $2, (select id from r2), now() - interval '1 day', 1.0, 1)`,
		uid, rid); err != nil {
		t.Fatal(err)
	}

	got, err := LoadSatisfaction(ctx, pool, []string{uid})
	if err != nil {
		t.Fatal(err)
	}
	if ema, ok := got[uid]; !ok || ema < 0.699 || ema > 0.701 {
		t.Fatalf("got %v (ok=%v), want 0.7", ema, ok)
	}
	if _, ok := got["00000000-0000-0000-0000-000000000000"]; ok {
		t.Fatal("無樣本的成員不應出現在 map")
	}
}

func TestLoadSatisfactionPartitionsWindowByUser(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const u1 = "e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e1"
	const u2 = "e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e2"
	ids := []string{u1, u2}
	var rid string
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where host_id = any($1::uuid[])`, ids)
		pool.Exec(context.Background(), `delete from auth.users where id = any($1::uuid[])`, ids)
		pool.Exec(context.Background(), `delete from restaurants where place_id = 'test-satisfaction-partition'`)
	})
	if _, err := pool.Exec(ctx, `
		insert into auth.users (id, email)
		values ($1, 'sat-partition-u1@test.dev'), ($2, 'sat-partition-u2@test.dev')`, u1, u2); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into restaurants (place_id, name, lat, lng)
		 values ('test-satisfaction-partition', '分區測試', 25, 121) returning id`).Scan(&rid); err != nil {
		t.Fatal(err)
	}

	// 由舊到新交錯：u1=[1,0] → 0.7；u2=[0,1] → 0.3。
	base := []struct {
		userID  string
		daysAgo int
		hit     float64
	}{
		{u1, 22, 1.0},
		{u2, 21, 0.0},
		{u1, 20, 0.0},
		{u2, 19, 1.0},
	}
	for _, s := range base {
		if _, err := pool.Exec(ctx, `
			with r as (insert into rooms (host_id) values ($1) returning id)
			insert into dining_history (user_id, restaurant_id, room_id, decided_at, pref_hit)
			select $1, $2, id, now() - make_interval(days => $3), $4 from r`,
			s.userID, rid, s.daysAgo, s.hit); err != nil {
			t.Fatal(err)
		}
	}

	assertEMA := func(got map[string]float64) {
		t.Helper()
		if ema, ok := got[u1]; !ok || ema < 0.699 || ema > 0.701 {
			t.Fatalf("u1 got %v (ok=%v), want 0.7", ema, ok)
		}
		if ema, ok := got[u2]; !ok || ema < 0.299 || ema > 0.301 {
			t.Fatalf("u2 got %v (ok=%v), want 0.3", ema, ok)
		}
	}
	got, err := LoadSatisfaction(ctx, pool, ids)
	if err != nil {
		t.Fatal(err)
	}
	assertEMA(got)

	// 再加 18 筆較新的 u2=0.3 形成 22 筆全域樣本；正確的 per-user window 不改兩人 EMA。
	// 若拿掉 partition by user_id，global rn<=20 會丟掉 u1 的舊樣本，使 u1 EMA 從 0.7 變 0。
	for i := 1; i <= 18; i++ {
		if _, err := pool.Exec(ctx, `
			with r as (insert into rooms (host_id) values ($1) returning id)
			insert into dining_history (user_id, restaurant_id, room_id, decided_at, pref_hit)
			select $1, $2, id, now() - make_interval(days => $3), 0.3 from r`,
			u2, rid, 19-i); err != nil {
			t.Fatal(err)
		}
	}
	got, err = LoadSatisfaction(ctx, pool, ids)
	if err != nil {
		t.Fatal(err)
	}
	assertEMA(got)
}

// 視窗邊界（eng review Test Review）：21 筆中最舊一筆 pref_hit=0、其餘 20 筆 =1。
// 視窗正確丟掉最舊 → 摺 20 筆全 1 → EMA 恰為 1.0；沒丟 → 初值 0 使 EMA < 1.0。
func TestLoadSatisfactionWindowDropsOldest(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const uid = "b8b8b8b8-b8b8-b8b8-b8b8-b8b8b8b8b8b8"
	var rid string
	t.Cleanup(func() {
		// rooms.host_id → profiles 無 cascade：必須先刪 rooms 再刪 user，
		// 否則 profiles 刪除撞 FK、cleanup 靜默失敗留髒資料
		pool.Exec(context.Background(), `delete from rooms where host_id = $1`, uid)
		pool.Exec(context.Background(), `delete from auth.users where id = $1`, uid)
		pool.Exec(context.Background(), `delete from restaurants where place_id = 'test-satisfaction-window'`)
	})
	if _, err := pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'sat-window@test.dev')`, uid); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into restaurants (place_id, name, lat, lng) values ('test-satisfaction-window', '視窗測試', 25, 121)
		 returning id`).Scan(&rid); err != nil {
		t.Fatal(err)
	}
	// 逐筆插入（OV#25：`row_number() over ()` 無 ORDER BY 的順序未定義，
	// 不能拿 CTE returning 順序當序號）：i=1 為最舊（22-1=21 天前）且 pref_hit=0
	for i := 1; i <= 21; i++ {
		hit := 1.0
		if i == 1 {
			hit = 0
		}
		if _, err := pool.Exec(ctx, `
			with r as (insert into rooms (host_id) values ($1) returning id)
			insert into dining_history (user_id, restaurant_id, room_id, decided_at, pref_hit)
			select $1, $2, id, now() - make_interval(days => $3), $4 from r`,
			uid, rid, 22-i, hit); err != nil {
			t.Fatal(err)
		}
	}

	got, err := LoadSatisfaction(ctx, pool, []string{uid})
	if err != nil {
		t.Fatal(err)
	}
	if ema := got[uid]; ema != 1.0 {
		t.Fatalf("視窗應丟掉第 21 筆最舊樣本：got %v want 1.0", ema)
	}
}

// decided 當下的樣本寫入（eng review Test Review）：unnest 配對正確性 + 空偏好 → null（D22）
func TestRecordDecisionWritesPrefHit(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	ids := []string{
		"c9c9c9c9-c9c9-c9c9-c9c9-c9c9c9c9c9c1",
		"c9c9c9c9-c9c9-c9c9-c9c9-c9c9c9c9c9c2",
		"c9c9c9c9-c9c9-c9c9-c9c9-c9c9c9c9c9c3",
	}
	const roomID = "d9d9d9d9-d9d9-d9d9-d9d9-d9d9d9d9d9d9"
	var rid string
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id = any($1::uuid[])`, ids)
		pool.Exec(context.Background(), `delete from restaurants where place_id = 'test-prefhit-1'`)
	})
	if _, err := pool.Exec(ctx, `
		insert into auth.users (id, email)
		values ($1, 'ph1@test.dev'), ($2, 'ph2@test.dev'), ($3, 'ph3@test.dev')`,
		ids[0], ids[1], ids[2]); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into rooms (id, host_id, status) values ($1, $2, 'decided')`, roomID, ids[0]); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into restaurants (place_id, name, cuisine_tags, lat, lng)
		 values ('test-prefhit-1', '命中測試', '["japanese"]', 25, 121) returning id`).Scan(&rid); err != nil {
		t.Fatal(err)
	}

	members := []Member{
		{UserID: ids[0], Cuisines: []string{"japanese"}},  // 命中 → 1
		{UserID: ids[1], Cuisines: []string{"taiwanese"}}, // 未命中 → 0
		{UserID: ids[2], Cuisines: nil},                   // 空偏好 → null（無樣本，D22）
	}
	winner := Restaurant{ID: rid, CuisineTags: []string{"japanese"}}
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := RecordDecision(ctx, tx, roomID, members, winner); err != nil {
		t.Fatal(err)
	}
	if err := tx.Commit(ctx); err != nil {
		t.Fatal(err)
	}

	one, zero := 1.0, 0.0
	want := map[string]*float64{ids[0]: &one, ids[1]: &zero, ids[2]: nil}
	for uid, expected := range want {
		var got *float64
		if err := pool.QueryRow(ctx,
			`select pref_hit from dining_history where room_id = $1 and user_id = $2`,
			roomID, uid).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if (expected == nil) != (got == nil) {
			t.Errorf("user %s pref_hit nil 狀態 = %v, want %v", uid, got == nil, expected == nil)
		} else if expected != nil && *got != *expected {
			t.Errorf("user %s pref_hit = %v, want %v", uid, *got, *expected)
		}
	}
}

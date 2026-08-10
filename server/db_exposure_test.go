package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLoadExposureAggregatesAcrossMembers(t *testing.T) {
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

	const u1 = "d7d7d7d7-d7d7-d7d7-d7d7-d7d7d7d7d7d7"
	const u2 = "e7e7e7e7-e7e7-e7e7-e7e7-e7e7e7e7e7e7"
	var rid string
	t.Cleanup(func() {
		// 順序（OV#15）：先刪 users（cascade 清 exposure_stats），才刪得動被 FK 參照的餐廳
		pool.Exec(context.Background(), `delete from auth.users where id = any($1::uuid[])`, []string{u1, u2})
		pool.Exec(context.Background(), `delete from restaurants where place_id = 'test-exposure-1'`)
	})
	if _, err := pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'exp-a@test.dev'), ($2, 'exp-b@test.dev')`,
		u1, u2); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx,
		`insert into restaurants (place_id, name, lat, lng) values ('test-exposure-1', '曝光測試', 25, 121)
		 returning id`).Scan(&rid); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `
		insert into exposure_stats (user_id, restaurant_id, recommended_count, chosen_count)
		values ($1, $3, 2, 1), ($2, $3, 1, 0)`, u1, u2, rid); err != nil {
		t.Fatal(err)
	}

	got, err := LoadExposure(ctx, pool, []string{u1, u2}, []string{rid})
	if err != nil {
		t.Fatal(err)
	}
	if c := got[rid]; c.Recommended != 3 || c.Chosen != 1 {
		t.Fatalf("got %+v, want {Recommended:3 Chosen:1}", c)
	}
	if _, ok := got["00000000-0000-0000-0000-000000000000"]; ok {
		t.Fatal("無統計的餐廳不應出現在 map（zero value 即代表新店）")
	}
}

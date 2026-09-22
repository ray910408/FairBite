package main

import (
	"context"
	"fmt"
	"math"
	"testing"
	"time"
)

func TestLoadSatisfaction(t *testing.T) {
	const u1 = "e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e1"
	const u2 = "e8e8e8e8-e8e8-4e8e-8e8e-e8e8e8e8e8e2"
	type sample struct {
		userID  string
		daysAgo int
		hit     float64
		rating  *int
	}
	one := 1
	window := []sample{{u1, 21, 0, nil}}
	for day := 20; day >= 1; day-- {
		window = append(window, sample{u1, day, 1, nil})
	}
	partitionExtra := []sample{}
	for day := 18; day >= 1; day-- {
		partitionExtra = append(partitionExtra, sample{u2, day, 0.3, nil})
	}
	for _, tc := range []struct {
		name        string
		base, extra []sample
		want        map[string]float64
		exact       bool
	}{
		{"rating overrides preference hit", []sample{{u1, 2, 1, nil}, {u1, 1, 1, &one}}, nil, map[string]float64{u1: 0.7}, false},
		{"window partitions by user", []sample{{u1, 22, 1, nil}, {u2, 21, 0, nil}, {u1, 20, 0, nil}, {u2, 19, 1, nil}}, partitionExtra, map[string]float64{u1: 0.7, u2: 0.3}, false},
		{"window drops oldest of 21 samples", window, nil, map[string]float64{u1: 1}, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
			defer cancel()
			pool := newTestPool(t, ctx)
			ids := []string{u1, u2}
			var rid string
			t.Cleanup(func() {
				// rooms.host_id has no cascade; remove rooms before users and restaurants.
				pool.Exec(context.Background(), `delete from rooms where host_id = any($1::uuid[])`, ids)
				pool.Exec(context.Background(), `delete from auth.users where id = any($1::uuid[])`, ids)
				pool.Exec(context.Background(), `delete from restaurants where place_id = 'test-satisfaction-table'`)
			})
			for i, uid := range ids {
				if _, err := pool.Exec(ctx, `insert into auth.users (id,email) values ($1,$2)`, uid, fmt.Sprintf("sat-table-%d@test.dev", i)); err != nil {
					t.Fatal(err)
				}
			}
			if err := pool.QueryRow(ctx, `insert into restaurants (place_id,name,lat,lng,source) values ('test-satisfaction-table','滿足度測試',25,121,'google') returning id`).Scan(&rid); err != nil {
				t.Fatal(err)
			}
			insert := func(samples []sample) {
				t.Helper()
				// Explicit dates avoid relying on unspecified CTE returning order.
				for _, s := range samples {
					if _, err := pool.Exec(ctx, `with r as (insert into rooms (host_id) values ($1) returning id)
						insert into dining_history (user_id,restaurant_id,room_id,decided_at,pref_hit,rating)
						select $1,$2,id,now()-make_interval(days => $3),$4,$5 from r`, s.userID, rid, s.daysAgo, s.hit, s.rating); err != nil {
						t.Fatal(err)
					}
				}
			}
			check := func() {
				t.Helper()
				got, err := LoadSatisfaction(ctx, pool, ids)
				if err != nil {
					t.Fatal(err)
				}
				for uid, want := range tc.want {
					ema, ok := got[uid]
					if !ok || math.Abs(ema-want) > 0.001 || (tc.exact && ema != want) {
						t.Fatalf("user %s EMA=%v (present=%v), want %v", uid, ema, ok, want)
					}
				}
				if len(got) != len(tc.want) {
					t.Fatalf("members without samples must be absent: %v", got)
				}
				if _, ok := got["00000000-0000-0000-0000-000000000000"]; ok {
					t.Fatal("unrequested member present")
				}
			}
			insert(tc.base)
			check()
			if len(tc.extra) > 0 {
				// 22 global samples must not evict either of u1's two samples.
				insert(tc.extra)
				check()
			}
		})
	}
}

// decided 當下的樣本寫入（eng review Test Review）：unnest 配對正確性 + 空偏好 → null（D22）
func TestRecordDecisionWritesPrefHit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool := newTestPool(t, ctx)

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
		`insert into restaurants (place_id, name, cuisine_tags, lat, lng, source)
		 values ('test-prefhit-1', '命中測試', '["japanese"]', 25, 121, 'google') returning id`).Scan(&rid); err != nil {
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
	for _, tc := range []struct {
		name, uid string
		want      *float64
	}{
		{"preference hit", ids[0], &one}, {"preference miss", ids[1], &zero}, {"no preference is null", ids[2], nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			uid, expected := tc.uid, tc.want
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
		})
	}
}

func TestPrefHitCountsQueryMatches(t *testing.T) {
	m := Member{UserID: "u1", Cuisines: []string{"ramen"}}
	winner := Restaurant{ID: "r1", QueryMatches: []string{"ramen"}}
	if v, ok := prefHit(m, winner); !ok || v != 1 {
		t.Fatalf("prefHit = (%v,%v), want (1,true)——滿足度樣本吃 query_match（決策 #8）", v, ok)
	}
}

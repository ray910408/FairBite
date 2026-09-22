package main

import (
	"context"
	"testing"
	"time"
)

// ADR-0007 前置：吃過的店在房刪後仍可讀（restaurants_select 的 dining_history 條款）。
// room_id = null 模擬「房已刪」（0011 set null 後的長期形態）。
func TestDinedRestaurantVisibleWithoutRoomMembership(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool := newTestPool(t, ctx)

	const diner = "a7a7a7a7-a7a7-a7a7-a7a7-a7a7a7a7a7a7"
	const stranger = "b7b7b7b7-b7b7-b7b7-b7b7-b7b7b7b7b7b7"
	const restaurantID = "c7c7c7c7-c7c7-c7c7-c7c7-c7c7c7c7c7c7"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from dining_history where user_id = $1`, diner)
		pool.Exec(context.Background(), `delete from restaurants where id = $1`, restaurantID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1, $2)`, diner, stranger)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email)
		values ($1, 'diner@test.dev'), ($2, 'stranger@test.dev')`, diner, stranger); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into restaurants
		(id, place_id, name, cuisine_tags, price_level, lat, lng, opening_hours, source)
		values ($1, 'visibility-test-1', '歷史可見性測試店', '["japanese"]', 1, 25.0478, 121.5171,
			'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}',
			'google')`, restaurantID); err != nil {
		t.Fatal(err)
	}
	// room_id 給 null：0011 之後刪房留下的長期形態
	if _, err := pool.Exec(ctx, `insert into dining_history (user_id, restaurant_id, room_id)
		values ($1, $2, null)`, diner, restaurantID); err != nil {
		t.Fatal(err)
	}

	countAs := func(t *testing.T, uid string) int {
		t.Helper()
		tx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer tx.Rollback(ctx)
		if _, err := tx.Exec(ctx, `set local role authenticated`); err != nil {
			t.Fatal(err)
		}
		if _, err := tx.Exec(ctx,
			`select set_config('request.jwt.claims', $1, true)`,
			`{"sub":"`+uid+`"}`); err != nil {
			t.Fatal(err)
		}
		var n int
		if err := tx.QueryRow(ctx,
			`select count(*) from restaurants where id = $1`, restaurantID).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	for _, tc := range []struct {
		name, uid string
		want      int
	}{
		{"diner retains access after room deletion", diner, 1},
		{"stranger has no access", stranger, 0},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if got := countAs(t, tc.uid); got != tc.want {
				t.Fatalf("visible rows=%d, want %d", got, tc.want)
			}
		})
	}
}

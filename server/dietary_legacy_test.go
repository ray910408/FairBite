package main

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestDietaryLegacyHalalFromDatabaseIsIgnored(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	const (
		userID = "83838383-8383-4383-8383-838383838383"
		roomID = "84848484-8484-4484-8484-848484848484"
	)
	if _, err := pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `delete from auth.users where id = $1`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values ($1, 'legacy-halal@test.dev')`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.rooms (id, host_id, status) values ($1, $2, 'lobby')`, roomID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, dietary, max_distance_m, transport)
		values ($1, $2, 500, '[]', '["halal"]', 2000, 'walking')`, roomID, userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
		_, _ = pool.Exec(ctx, `delete from auth.users where id = $1`, userID)
	})

	members, err := LoadMembers(ctx, pool, roomID)
	if err != nil {
		t.Fatal(err)
	}
	if len(members) != 1 || len(members[0].Dietary) != 1 || members[0].Dietary[0] != "halal" {
		t.Fatalf("舊 halal 字串必須能從 DB 正常載入，got %+v", members)
	}
	result := Evaluate(EngineInput{
		Restaurants: []Restaurant{{
			PlaceID: "legacy-halal-compatible", Name: "一般餐廳", CuisineTags: []string{"taiwanese"},
			PriceLevel: 1, Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440}),
		}},
		Members: members, Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
	})
	if len(result.Kept) != 1 || len(result.Excluded) != 0 {
		t.Fatalf("已移除的舊 halal 值必須視為未知 neutral，不得錯誤排除：kept=%+v excluded=%+v",
			result.Kept, result.Excluded)
	}
}

func TestLegacyUnsupportedDietaryValuesAreIgnored(t *testing.T) {
	restaurant := Restaurant{
		PlaceID: "legacy-compatible", Name: "一般餐廳",
		CuisineTags: []string{"steak", "beef_noodle", "ramen", "dimsum"},
		PriceLevel: 1, Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440}),
	}
	for _, tc := range []struct {
		name    string
		dietary []string
	}{
		{"only_no_beef", []string{"no_beef"}},
		{"only_no_pork", []string{"no_pork"}},
		{"mixed_no_beef_no_pork", []string{"no_beef", "no_pork"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := Evaluate(EngineInput{
				Restaurants: []Restaurant{restaurant},
				Members: []Member{{UserID: "legacy", DisplayName: "舊資料", BudgetMax: 1600,
					Dietary: tc.dietary, MaxDistanceM: 3000, Transport: "walking"}},
				Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170,
			})
			if len(result.Kept) != 1 || len(result.Excluded) != 0 {
				t.Fatalf("舊 unsupported dietary 值須安全忽略：dietary=%v kept=%+v excluded=%+v",
					tc.dietary, result.Kept, result.Excluded)
			}
		})
	}
}

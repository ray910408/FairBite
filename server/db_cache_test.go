package main

import (
	"context"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func TestCachedRestaurantsPersistAndFilterPrimaryType(t *testing.T) {
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
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	valid := []Restaurant{{
		PlaceID: "cache-primary-valid", Name: "可前往麵店", PrimaryType: "noodle_shop",
		Lat: 0.12345, Lng: 0.12345, Hours: OpeningHours{},
	}}
	if err := UpsertRestaurants(ctx, tx, valid, "google"); err != nil {
		t.Fatal(err)
	}
	var storedPrimaryType string
	if err := tx.QueryRow(ctx, `select primary_type from restaurants where place_id = $1`, valid[0].PlaceID).
		Scan(&storedPrimaryType); err != nil {
		t.Fatal(err)
	}
	if storedPrimaryType != valid[0].PrimaryType {
		t.Fatalf("stored primary_type = %q, want %q", storedPrimaryType, valid[0].PrimaryType)
	}
	valid[0].PrimaryType = "restaurant"
	if err := UpsertRestaurants(ctx, tx, valid, "google"); err != nil {
		t.Fatal(err)
	}
	if err := tx.QueryRow(ctx, `select primary_type from restaurants where place_id = $1`, valid[0].PlaceID).
		Scan(&storedPrimaryType); err != nil {
		t.Fatal(err)
	}
	if storedPrimaryType != valid[0].PrimaryType {
		t.Fatalf("updated primary_type = %q, want %q", storedPrimaryType, valid[0].PrimaryType)
	}

	if _, err := tx.Exec(ctx, `
		insert into restaurants (place_id, name, primary_type, lat, lng, source, fetched_at)
		values
		  ('cache-primary-hypermarket', '量販店', 'hypermarket', 0.12345, 0.12345, 'google', now()),
		  ('cache-primary-null', '舊有未知資料', null, 0.12345, 0.12345, 'google', now())`); err != nil {
		t.Fatal(err)
	}

	cached, err := LoadCachedRestaurants(ctx, tx, 0.12345, 0.12345, 10, false)
	if err != nil {
		t.Fatal(err)
	}
	if len(cached) != 1 || cached[0].PlaceID != valid[0].PlaceID {
		t.Fatalf("快取只能保留正面表列主類型，got %+v", cached)
	}
	if cached[0].PrimaryType != valid[0].PrimaryType {
		t.Fatalf("loaded primary_type = %q, want %q", cached[0].PrimaryType, valid[0].PrimaryType)
	}
}

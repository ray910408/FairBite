package main

import (
	"context"
	"testing"
)

func TestCachedRestaurantsPersistAndFilterPrimaryType(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t, ctx)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	valid := []Restaurant{{
		PlaceID: "cache-primary-valid", Name: "可前往麵店", PrimaryType: "noodle_shop",
		Lat: 0.12345, Lng: 0.12345, Hours: OpeningHours{}, TimeZone: "Asia/Tokyo",
	}}
	if _, err := UpsertRestaurants(ctx, tx, valid, "google"); err != nil {
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
	valid[0].TimeZone = "" // provider 這次沒給時區：不得抹掉已知值
	if _, err := UpsertRestaurants(ctx, tx, valid, "google"); err != nil {
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
	if cached[0].TimeZone != "Asia/Tokyo" {
		t.Fatalf("loaded time_zone = %q, want Asia/Tokyo", cached[0].TimeZone)
	}
}

// 批次 upsert 的回傳 ID 要逐列對上 DB：callback 寫錯 slot、漏掛 QueryRow 都會在這裡現形。
// 第二次走 on conflict 分支，ID 必須沿用；nil CuisineTags 必須落成 []。
func TestUpsertRestaurantsReturnsEachRowID(t *testing.T) {
	ctx := context.Background()
	pool := newTestPool(t, ctx)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = tx.Rollback(ctx) })

	in := []Restaurant{
		{PlaceID: "upsert-id-a", Name: "甲", PrimaryType: "restaurant", Lat: 0.2, Lng: 0.2, Hours: OpeningHours{}},
		{PlaceID: "upsert-id-b", Name: "乙", PrimaryType: "restaurant", Lat: 0.2, Lng: 0.2, Hours: OpeningHours{}, CuisineTags: []string{"japanese"}},
		{PlaceID: "upsert-id-c", Name: "丙", PrimaryType: "restaurant", Lat: 0.2, Lng: 0.2, Hours: OpeningHours{}},
	}
	wantTags := []string{`[]`, `["japanese"]`, `[]`}
	first, err := UpsertRestaurants(ctx, tx, in, "google")
	if err != nil {
		t.Fatal(err)
	}
	again, err := UpsertRestaurants(ctx, tx, in, "google")
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != len(in) || len(again) != len(in) {
		t.Fatalf("returned %d/%d rows, want %d", len(first), len(again), len(in))
	}
	seen := map[string]bool{}
	for i := range in {
		var id, tags string
		if err := tx.QueryRow(ctx, `select id::text, cuisine_tags::text from restaurants where place_id = $1`, in[i].PlaceID).
			Scan(&id, &tags); err != nil {
			t.Fatal(err)
		}
		if first[i].PlaceID != in[i].PlaceID || first[i].ID != id || seen[id] {
			t.Fatalf("row %d: returned %s/%q, DB id %q (seen=%v)", i, first[i].PlaceID, first[i].ID, id, seen[id])
		}
		seen[id] = true
		if again[i].ID != id {
			t.Fatalf("row %d: conflict upsert returned %q, want existing id %q", i, again[i].ID, id)
		}
		if in[i].ID != "" {
			t.Fatalf("row %d: input slice must not be mutated, got ID %q", i, in[i].ID)
		}
		if tags != wantTags[i] {
			t.Fatalf("row %d: cuisine_tags = %s, want %s", i, tags, wantTags[i])
		}
	}
}

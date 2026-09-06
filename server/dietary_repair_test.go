package main

import (
	"context"
	"errors"
	"os"
	"testing"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestLegacyDietaryRepair(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; requires local Supabase")
	}
	// Read the actual operational SQL. Supabase's pgTAP runner only mounts tests/,
	// so a psql include outside that directory would not run in CI.
	repair, err := os.ReadFile("../supabase/repairs/20260906_legacy_dietary.sql")
	if err != nil {
		t.Fatal(err)
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	exec := func(sql string) {
		t.Helper()
		if _, err := tx.Exec(ctx, sql); err != nil {
			t.Fatal(err)
		}
	}
	query := func(sql string) string {
		t.Helper()
		var value string
		if err := tx.QueryRow(ctx, sql).Scan(&value); err != nil {
			t.Fatal(err)
		}
		return value
	}
	wantError := func(sql, code string) {
		t.Helper()
		exec("savepoint expected_error")
		_, err := tx.Exec(ctx, sql)
		var pgErr *pgconn.PgError
		if !errors.As(err, &pgErr) || pgErr.Code != code {
			t.Fatalf("expected SQLSTATE %s, got %v", code, err)
		}
		exec("rollback to savepoint expected_error; release savepoint expected_error")
	}
	// Simulate the pre-migration state without changing persistent DB state.
	exec(`alter table public.room_members drop constraint room_members_dietary_bounds;
		insert into auth.users(id,email) values
		 ('96000000-0000-4000-8000-000000000101','repair-a@test.dev'),
		 ('96000000-0000-4000-8000-000000000102','repair-b@test.dev'),
		 ('96000000-0000-4000-8000-000000000103','repair-c@test.dev');
		insert into public.rooms(id,host_id,status) values
		 ('96000000-0000-4000-8000-000000000110','96000000-0000-4000-8000-000000000101','candidates');
		insert into public.room_members(room_id,user_id,dietary) values
		 ('96000000-0000-4000-8000-000000000110','96000000-0000-4000-8000-000000000101','["no_pork"]'),
		 ('96000000-0000-4000-8000-000000000110','96000000-0000-4000-8000-000000000102','["vegetarian"]'),
		 ('96000000-0000-4000-8000-000000000110','96000000-0000-4000-8000-000000000103','[]');`)
	const constraint = `alter table public.room_members add constraint room_members_dietary_bounds
		check (public.valid_member_choices(dietary,array['vegetarian'],10))`
	wantError(constraint, "23514") // Original production failure.
	const members = `select jsonb_agg(to_jsonb(m)-'dietary' order by room_id,user_id)::text from public.room_members m`
	before := query(members)
	exec(string(repair))
	if query(members) != before {
		t.Fatal("repair changed non-dietary fields")
	}
	if got := query(`select jsonb_agg(dietary order by user_id)::text from public.room_members
		where room_id='96000000-0000-4000-8000-000000000110'`); got != `[[], ["vegetarian"], []]` {
		t.Fatalf("repair altered unrelated preferences: %s", got)
	}
	if got := query(`select original_dietary::text from private_member_repairs.dietary_20260906
		where user_id='96000000-0000-4000-8000-000000000101'`); got != `["no_pork"]` {
		t.Fatalf("original not preserved: %s", got)
	}
	const backups = `select jsonb_agg(b order by room_id,user_id)::text from private_member_repairs.dietary_20260906 b`
	backup := query(backups)
	exec(string(repair))
	if query(backups) != backup {
		t.Fatal("rerun overwrote original backup or timestamp")
	}
	// Unknown/mixed choices must not be silently stripped.
	exec(`update public.room_members set dietary='["vegetarian","no_pork","unknown"]'
		where user_id='96000000-0000-4000-8000-000000000103'`)
	exec(string(repair))
	if got := query(`select dietary::text from public.room_members
		where user_id='96000000-0000-4000-8000-000000000103'`); got != `["vegetarian", "no_pork", "unknown"]` {
		t.Fatalf("unreviewed choices were changed: %s", got)
	}
	// More matching rows than the reviewed production snapshot must fail atomically.
	exec(`update public.room_members set dietary='["no_pork"]'
		where user_id in ('96000000-0000-4000-8000-000000000101','96000000-0000-4000-8000-000000000103')`)
	wantError(string(repair), "P0001")
	if query(backups) != backup || query(`select count(*)::text from public.room_members where dietary='["no_pork"]'`) != "2" {
		t.Fatal("rejected repair left partial writes")
	}
	exec(`update public.room_members set dietary='[]'
		where user_id in ('96000000-0000-4000-8000-000000000101','96000000-0000-4000-8000-000000000103')`)
	exec(constraint)
	wantError(`update public.room_members set dietary='["no_pork"]'
		where user_id='96000000-0000-4000-8000-000000000101'`, "23514")
	for _, role := range []string{"anon", "authenticated", "service_role"} {
		exec("set local role " + role)
		wantError("select * from private_member_repairs.dietary_20260906", "42501")
		exec("reset role")
	}
}

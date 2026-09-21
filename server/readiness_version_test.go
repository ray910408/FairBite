package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgxpool"
)

type readinessRPCResult struct {
	updated bool
	err     error
}

func TestSetMemberReadySerializesWithLobbyRelocation(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL is required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)

	t.Run("relocation commits before waiting old-version ready", func(t *testing.T) {
		const userID = "81900000-0000-4000-8000-000000000001"
		const roomID = "81900000-0000-4000-8000-000000000011"
		seedReadinessVersionFixture(t, ctx, pool, userID, roomID)

		relocationTx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer relocationTx.Rollback(ctx)
		relocateLobby(t, ctx, relocationTx, roomID)

		readyTx, readyPID := beginAuthenticatedReadyTx(t, ctx, pool, userID)
		defer readyTx.Rollback(ctx)
		readyDone := make(chan readinessRPCResult, 1)
		go func() {
			var updated bool
			err := readyTx.QueryRow(ctx,
				`select public.set_member_ready($1, true, 0)`, roomID).Scan(&updated)
			readyDone <- readinessRPCResult{updated: updated, err: err}
		}()

		waitForBackendLock(t, ctx, pool, readyPID, readyDone)
		if err := relocationTx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		result := receiveReadyResult(t, ctx, readyDone)
		if result.err != nil {
			t.Fatal(result.err)
		}
		if result.updated {
			t.Fatal("old-version ready succeeded after relocation, want false")
		}
		if err := readyTx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		assertMemberReady(t, ctx, pool, roomID, false)
	})

	t.Run("ready commits before relocation reset", func(t *testing.T) {
		const userID = "81900000-0000-4000-8000-000000000002"
		const roomID = "81900000-0000-4000-8000-000000000012"
		seedReadinessVersionFixture(t, ctx, pool, userID, roomID)

		readyTx, _ := beginAuthenticatedReadyTx(t, ctx, pool, userID)
		defer readyTx.Rollback(ctx)
		var updated bool
		if err := readyTx.QueryRow(ctx,
			`select public.set_member_ready($1, true, 0)`, roomID).Scan(&updated); err != nil {
			t.Fatal(err)
		}
		if !updated {
			t.Fatal("current-version ready = false, want true")
		}

		relocationTx, err := pool.Begin(ctx)
		if err != nil {
			t.Fatal(err)
		}
		defer relocationTx.Rollback(ctx)
		var relocationPID int
		if err := relocationTx.QueryRow(ctx, `select pg_backend_pid()`).Scan(&relocationPID); err != nil {
			t.Fatal(err)
		}
		relocationDone := make(chan error, 1)
		go func() {
			_, err := relocationTx.Exec(ctx, `select id from public.rooms where id=$1 for update`, roomID)
			if err == nil {
				_, err = relocationTx.Exec(ctx,
					`update public.rooms set center_lat=25.1, center_lng=121.1, status='lobby', search_version=search_version+1 where id=$1`, roomID)
			}
			if err == nil {
				_, err = relocationTx.Exec(ctx, `update public.room_members set ready=false where room_id=$1`, roomID)
			}
			relocationDone <- err
		}()

		waitForBackendLock(t, ctx, pool, relocationPID, relocationDone)
		if err := readyTx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		select {
		case err := <-relocationDone:
			if err != nil {
				t.Fatal(err)
			}
		case <-ctx.Done():
			t.Fatal("relocation did not complete after ready commit")
		}
		if err := relocationTx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		assertMemberReady(t, ctx, pool, roomID, false)
	})

	t.Run("current version succeeds", func(t *testing.T) {
		const userID = "81900000-0000-4000-8000-000000000003"
		const roomID = "81900000-0000-4000-8000-000000000013"
		seedReadinessVersionFixture(t, ctx, pool, userID, roomID)
		if _, err := pool.Exec(ctx,
			`update public.rooms set search_version=search_version+1 where id=$1`, roomID); err != nil {
			t.Fatal(err)
		}

		readyTx, _ := beginAuthenticatedReadyTx(t, ctx, pool, userID)
		defer readyTx.Rollback(ctx)
		var updated bool
		if err := readyTx.QueryRow(ctx,
			`select public.set_member_ready($1, true, 1)`, roomID).Scan(&updated); err != nil {
			t.Fatal(err)
		}
		if !updated {
			t.Fatal("current-version ready = false, want true")
		}
		if err := readyTx.Commit(ctx); err != nil {
			t.Fatal(err)
		}
		assertMemberReady(t, ctx, pool, roomID, true)
	})
}

func seedReadinessVersionFixture(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID, roomID string) {
	t.Helper()
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from public.rooms where id=$1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id=$1`, userID)
	})
	if _, err := pool.Exec(ctx,
		`insert into auth.users(id,email) values($1,$2)`, userID, "ready-version-"+userID+"@test.dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into public.rooms(id,host_id,status,center_lat,center_lng) values($1,$2,'lobby',25,121)`, roomID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into public.room_members(room_id,user_id,ready) values($1,$2,false)`, roomID, userID); err != nil {
		t.Fatal(err)
	}
}

func beginAuthenticatedReadyTx(t *testing.T, ctx context.Context, pool *pgxpool.Pool, userID string) (pgx.Tx, int) {
	t.Helper()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	var pid int
	if err := tx.QueryRow(ctx, `select pg_backend_pid()`).Scan(&pid); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `set local role authenticated`); err != nil {
		t.Fatal(err)
	}
	claims := fmt.Sprintf(`{"sub":%q,"role":"authenticated"}`, userID)
	if _, err := tx.Exec(ctx, `select set_config('request.jwt.claims',$1,true)`, claims); err != nil {
		t.Fatal(err)
	}
	return tx, pid
}

func relocateLobby(t *testing.T, ctx context.Context, tx pgx.Tx, roomID string) {
	t.Helper()
	if _, err := tx.Exec(ctx, `select id from public.rooms where id=$1 for update`, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx,
		`update public.rooms set center_lat=25.1, center_lng=121.1, status='lobby', search_version=search_version+1 where id=$1`, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := tx.Exec(ctx, `update public.room_members set ready=false where room_id=$1`, roomID); err != nil {
		t.Fatal(err)
	}
}

func waitForBackendLock[T any](t *testing.T, ctx context.Context, pool *pgxpool.Pool, pid int, done <-chan T) {
	t.Helper()
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx,
			`select coalesce(wait_event_type='Lock',false) from pg_stat_activity where pid=$1`, pid).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			return
		}
		select {
		case <-done:
			t.Fatal("database operation completed before the expected row lock")
		case <-ctx.Done():
			t.Fatal("database operation did not block on the room row lock")
		case <-ticker.C:
		}
	}
}

func receiveReadyResult(t *testing.T, ctx context.Context, done <-chan readinessRPCResult) readinessRPCResult {
	t.Helper()
	select {
	case result := <-done:
		return result
	case <-ctx.Done():
		t.Fatal("ready RPC did not complete after room row lock release")
		return readinessRPCResult{}
	}
}

func assertMemberReady(t *testing.T, ctx context.Context, pool *pgxpool.Pool, roomID string, want bool) {
	t.Helper()
	var got bool
	if err := pool.QueryRow(ctx,
		`select ready from public.room_members where room_id=$1`, roomID).Scan(&got); err != nil {
		t.Fatal(err)
	}
	if got != want {
		t.Fatalf("ready = %v, want %v", got, want)
	}
}

package main

import (
	"context"
	"fmt"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestMemberConditionUpdateBlocksUntilFreezeCommit(t *testing.T) {
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

	const userID = "e5e5e5e5-e5e5-e5e5-e5e5-e5e5e5e5e5e5"
	const roomID = "f5f5f5f5-f5f5-f5f5-f5f5-f5f5f5f5f5f5"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id = $1`, userID)
	})
	if _, err := pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'member-freeze@test.dev')`, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into rooms (id, host_id, status) values ($1, $2, 'lobby')`, roomID, userID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into room_members (room_id, user_id) values ($1, $2)`, roomID, userID); err != nil {
		t.Fatal(err)
	}

	freezeTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer freezeTx.Rollback(ctx)
	if err := TransitionRoom(ctx, freezeTx, roomID, "lobby", "candidates"); err != nil {
		t.Fatal(err)
	}
	if _, err := LoadMembersForUpdate(ctx, freezeTx, roomID); err != nil {
		t.Fatal(err)
	}

	updateTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer updateTx.Rollback(ctx)
	var updatePID int
	if err := updateTx.QueryRow(ctx, `select pg_backend_pid()`).Scan(&updatePID); err != nil {
		t.Fatal(err)
	}
	if _, err := updateTx.Exec(ctx, `set local role authenticated`); err != nil {
		t.Fatal(err)
	}
	claims := fmt.Sprintf(`{"sub":%q,"role":"authenticated"}`, userID)
	if _, err := updateTx.Exec(ctx, `select set_config('request.jwt.claims', $1, true)`, claims); err != nil {
		t.Fatal(err)
	}

	type updateResult struct {
		rows int64
		err  error
	}
	updateDone := make(chan updateResult, 1)
	go func() {
		tag, err := updateTx.Exec(ctx,
			`update room_members set budget_max = 999 where room_id = $1 and user_id = $2`,
			roomID, userID)
		updateDone <- updateResult{rows: tag.RowsAffected(), err: err}
	}()

	// 不靠 sleep 猜時序：從 pg_stat_activity 確認 UPDATE 已卡在 freeze transaction 的 row lock。
	for {
		var waiting bool
		if err := pool.QueryRow(ctx,
			`select coalesce(wait_event_type = 'Lock', false) from pg_stat_activity where pid = $1`,
			updatePID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("condition update did not block on the freeze transaction")
		case <-time.After(10 * time.Millisecond):
		}
	}

	if err := freezeTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-updateDone
	if result.err != nil {
		t.Fatal(result.err)
	}
	if result.rows != 0 {
		t.Fatalf("frozen condition update affected %d rows, want 0", result.rows)
	}
	if err := updateTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var budget int
	if err := pool.QueryRow(ctx,
		`select budget_max from room_members where room_id = $1 and user_id = $2`, roomID, userID).
		Scan(&budget); err != nil {
		t.Fatal(err)
	}
	if budget != 300 {
		t.Fatalf("frozen budget = %d, want 300", budget)
	}
}

func TestJoinRoomBlocksUntilFreezeCommitThenReturnsNull(t *testing.T) {
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

	const hostID = "a6a6a6a6-a6a6-a6a6-a6a6-a6a6a6a6a6a6"
	const joinerID = "b6b6b6b6-b6b6-b6b6-b6b6-b6b6b6b6b6b6"
	const roomID = "c6c6c6c6-c6c6-c6c6-c6c6-c6c6c6c6c6c6"
	const roomCode = "LOCK06"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id = any($1::uuid[])`, []string{hostID, joinerID})
	})
	if _, err := pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'join-lock-host@test.dev'), ($2, 'join-lock-joiner@test.dev')`,
		hostID, joinerID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into rooms (id, code, host_id, status) values ($1, $2, $3, 'lobby')`,
		roomID, roomCode, hostID); err != nil {
		t.Fatal(err)
	}

	freezeTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer freezeTx.Rollback(ctx)
	if err := TransitionRoom(ctx, freezeTx, roomID, "lobby", "candidates"); err != nil {
		t.Fatal(err)
	}

	joinTx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer joinTx.Rollback(ctx)
	var joinPID int
	if err := joinTx.QueryRow(ctx, `select pg_backend_pid()`).Scan(&joinPID); err != nil {
		t.Fatal(err)
	}
	if _, err := joinTx.Exec(ctx, `set local role authenticated`); err != nil {
		t.Fatal(err)
	}
	claims := fmt.Sprintf(`{"sub":%q,"role":"authenticated"}`, joinerID)
	if _, err := joinTx.Exec(ctx, `select set_config('request.jwt.claims', $1, true)`, claims); err != nil {
		t.Fatal(err)
	}

	type joinResult struct {
		roomID pgtype.UUID
		err    error
	}
	joinDone := make(chan joinResult, 1)
	go func() {
		var joinedRoomID pgtype.UUID
		err := joinTx.QueryRow(ctx, `select public.join_room($1)`, roomCode).Scan(&joinedRoomID)
		joinDone <- joinResult{roomID: joinedRoomID, err: err}
	}()

	// 不靠 sleep 猜時序：確認 join_room 已卡在 freeze transaction 的 rooms row lock。
	for {
		var waiting bool
		if err := pool.QueryRow(ctx,
			`select coalesce(wait_event_type = 'Lock', false) from pg_stat_activity where pid = $1`,
			joinPID).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case result := <-joinDone:
			t.Fatalf("join_room completed before freeze commit: room_id=%v err=%v", result.roomID, result.err)
		case <-ctx.Done():
			t.Fatal("join_room did not block on the freeze transaction")
		case <-time.After(10 * time.Millisecond):
		}
	}

	if err := freezeTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	result := <-joinDone
	if result.err != nil {
		t.Fatal(result.err)
	}
	if result.roomID.Valid {
		t.Fatalf("join_room returned room %s after freeze, want null", result.roomID.String())
	}
	if err := joinTx.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	var memberCount int
	if err := pool.QueryRow(ctx,
		`select count(*) from room_members where room_id = $1 and user_id = $2`, roomID, joinerID).
		Scan(&memberCount); err != nil {
		t.Fatal(err)
	}
	if memberCount != 0 {
		t.Fatalf("frozen join inserted %d room_members rows, want 0", memberCount)
	}
}

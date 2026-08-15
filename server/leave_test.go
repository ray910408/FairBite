package main

import (
	"context"
	"os"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func leaveTestPool(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	t.Cleanup(cancel)
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })
	return pool, ctx
}

// 三人房：房主先退（繼任給 joined_at 最早的 B）→ B 退（繼任 C）→ C 退（末位刪房）。
// dining_history 掛在房上驗 set null 存活。
func TestLeaveSuccessionAndLastLeaveDeletesRoom(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "11111111-aaaa-4aaa-8aaa-111111111111"
	const memberB = "22222222-aaaa-4aaa-8aaa-222222222222"
	const memberC = "33333333-aaaa-4aaa-8aaa-333333333333"
	const roomID = "44444444-aaaa-4aaa-8aaa-444444444444"
	const restaurantID = "55555555-aaaa-4aaa-8aaa-555555555555"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from dining_history where user_id in ($1,$2,$3)`, host, memberB, memberC)
		pool.Exec(context.Background(), `delete from restaurants where id = $1`, restaurantID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2,$3)`, host, memberB, memberC)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'leave-host@test.dev'), ($2,'leave-b@test.dev'), ($3,'leave-c@test.dev')`,
		host, memberB, memberC); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'decided', 25.0478, 121.5170)`, roomID, host); err != nil {
		t.Fatal(err)
	}
	// joined_at 手動錯開：host 最晚、B 最早——繼任必須看 joined_at 不是插入順序
	if _, err := pool.Exec(ctx, `insert into room_members (room_id, user_id, joined_at) values
		($1, $2, now()),
		($1, $3, now() - interval '2 minutes'),
		($1, $4, now() - interval '1 minute')`, roomID, host, memberB, memberC); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into restaurants
		(id, place_id, name, cuisine_tags, price_level, lat, lng, opening_hours, source)
		values ($1, 'leave-test-1', '退房測試店', '["japanese"]', 1, 25.0478, 121.5171,
			'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}',
			'google')`, restaurantID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into dining_history (user_id, restaurant_id, room_id)
		values ($1, $2, $3)`, host, restaurantID, roomID); err != nil {
		t.Fatal(err)
	}

	// 房主退：繼任給 joined_at 最早的 B
	if err := leaveOneRoom(ctx, pool, nil, roomID, host); err != nil {
		t.Fatal(err)
	}
	var newHost string
	if err := pool.QueryRow(ctx, `select host_id from rooms where id = $1`, roomID).Scan(&newHost); err != nil {
		t.Fatal(err)
	}
	if newHost != memberB {
		t.Fatalf("繼任應給 joined_at 最早者 B：got %s", newHost)
	}
	// 已退者再退（房仍活著）：RowsAffected=0 早退分支，冪等且不動房（eng review 5A）
	if err := leaveOneRoom(ctx, pool, nil, roomID, host); err != nil {
		t.Fatalf("已退者重複退房應冪等：%v", err)
	}
	var membersLeft int
	if err := pool.QueryRow(ctx, `select count(*) from room_members where room_id = $1`, roomID).Scan(&membersLeft); err != nil {
		t.Fatal(err)
	}
	if membersLeft != 2 {
		t.Fatalf("重複退房不得影響剩餘成員：got %d, want 2", membersLeft)
	}

	// B 退 → 繼任 C；C 退 → 末位刪房
	if err := leaveOneRoom(ctx, pool, nil, roomID, memberB); err != nil {
		t.Fatal(err)
	}
	if err := leaveOneRoom(ctx, pool, nil, roomID, memberC); err != nil {
		t.Fatal(err)
	}
	var roomCount int
	if err := pool.QueryRow(ctx, `select count(*) from rooms where id = $1`, roomID).Scan(&roomCount); err != nil {
		t.Fatal(err)
	}
	if roomCount != 0 {
		t.Fatal("末位退房應刪除房間")
	}
	// dining_history 存活且 room_id 轉 null（0011）
	var historyRoom *string
	if err := pool.QueryRow(ctx, `select room_id from dining_history
		where user_id = $1 and restaurant_id = $2`, host, restaurantID).Scan(&historyRoom); err != nil {
		t.Fatal(err)
	}
	if historyRoom != nil {
		t.Fatal("刪房後 dining_history.room_id 應為 null")
	}

	// 冪等：已退的人再退、房已刪再退，都靜默成功
	if err := leaveOneRoom(ctx, pool, nil, roomID, host); err != nil {
		t.Fatalf("房已刪的退房應冪等：%v", err)
	}
}

// voting 中退房：退出者的否決票刪除，同交易 rescore 讓被否決的候選回盤（ADR-0007）。
func TestLeaveDuringVotingDeletesVotesAndRescores(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "66666666-bbbb-4bbb-8bbb-666666666666"
	const memberB = "77777777-bbbb-4bbb-8bbb-777777777777"
	const roomID = "88888888-bbbb-4bbb-8bbb-888888888888"
	const restaurantID = "99999999-bbbb-4bbb-8bbb-999999999999"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from restaurants where id = $1`, restaurantID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2)`, host, memberB)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'rescore-host@test.dev'), ($2,'rescore-b@test.dev')`, host, memberB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'voting', 25.0478, 121.5170)`, roomID, host); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_members (room_id, user_id, joined_at) values
		($1, $2, now() - interval '1 minute'), ($1, $3, now())`, roomID, host, memberB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into restaurants
		(id, place_id, name, cuisine_tags, price_level, lat, lng, opening_hours, source)
		values ($1, 'rescore-test-1', '回盤測試店', '["japanese"]', 1, 25.0478, 121.5171,
			'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}',
			'google')`, restaurantID); err != nil {
		t.Fatal(err)
	}
	// 模擬「上次 rescore 時 B 的否決生效」的落盤形態＋B 的票
	if _, err := pool.Exec(ctx, `insert into room_candidates
		(room_id, restaurant_id, status, exclusion_reason, exclusion_kinds, exposure_counted)
		values ($1, $2, 'excluded', '被否決', '{"veto"}', true)`, roomID, restaurantID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into votes (room_id, user_id, restaurant_id, kind)
		values ($1, $2, $3, 'veto')`, roomID, memberB, restaurantID); err != nil {
		t.Fatal(err)
	}

	if err := leaveOneRoom(ctx, pool, nil, roomID, memberB); err != nil {
		t.Fatal(err)
	}

	var voteCount int
	if err := pool.QueryRow(ctx, `select count(*) from votes
		where room_id = $1 and user_id = $2`, roomID, memberB).Scan(&voteCount); err != nil {
		t.Fatal(err)
	}
	if voteCount != 0 {
		t.Fatal("退房應刪除退出者的票")
	}
	var status string
	if err := pool.QueryRow(ctx, `select status from room_candidates
		where room_id = $1 and restaurant_id = $2`, roomID, restaurantID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if status != "kept" {
		t.Fatalf("退房 rescore 後被否決候選應回盤：status = %s, want kept", status)
	}
}

// eng review C8：同刻 joined_at 的繼任 tie-break 以 user_id 升冪決定。
func TestLeaveSuccessionTieBreakByUserID(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "99999999-ffff-4fff-8fff-999999999999"
	const memberB = "11111111-ffff-4fff-8fff-111111111111" // user_id 較小 → tie-break 勝出
	const memberC = "22222222-ffff-4fff-8fff-222222222222"
	const roomID = "33333333-ffff-4fff-8fff-333333333333"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2,$3)`, host, memberB, memberC)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'tie-host@test.dev'), ($2,'tie-b@test.dev'), ($3,'tie-c@test.dev')`,
		host, memberB, memberC); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, host_id, status)
		values ($1, $2, 'lobby')`, roomID, host); err != nil {
		t.Fatal(err)
	}
	// B、C 同刻加入：繼任順位只能由 user_id 決定
	if _, err := pool.Exec(ctx, `insert into room_members (room_id, user_id, joined_at) values
		($1, $2, '2026-08-15T00:00:00Z'),
		($1, $3, '2026-08-15T00:01:00Z'),
		($1, $4, '2026-08-15T00:01:00Z')`, roomID, host, memberB, memberC); err != nil {
		t.Fatal(err)
	}
	if err := leaveOneRoom(ctx, pool, nil, roomID, host); err != nil {
		t.Fatal(err)
	}
	var newHost string
	if err := pool.QueryRow(ctx, `select host_id from rooms where id = $1`, roomID).Scan(&newHost); err != nil {
		t.Fatal(err)
	}
	if newHost != memberB {
		t.Fatalf("同刻 joined_at 應以 user_id 升冪繼任：got %s, want %s", newHost, memberB)
	}
}

// eng review C8：並發雙退——鎖序化下皆無錯誤、恰一人觸發刪房、零殘留。
func TestConcurrentLeavesDeleteRoomExactlyOnce(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "44444444-ffff-4fff-8fff-444444444444"
	const memberB = "55555555-ffff-4fff-8fff-555555555555"
	const roomID = "66666666-ffff-4fff-8fff-666666666666"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2)`, host, memberB)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'con-host@test.dev'), ($2,'con-b@test.dev')`, host, memberB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, host_id, status)
		values ($1, $2, 'lobby')`, roomID, host); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_members (room_id, user_id) values
		($1, $2), ($1, $3)`, roomID, host, memberB); err != nil {
		t.Fatal(err)
	}
	errs := make(chan error, 2)
	for _, uid := range []string{host, memberB} {
		uid := uid
		go func() { errs <- leaveOneRoom(ctx, pool, nil, roomID, uid) }()
	}
	for i := 0; i < 2; i++ {
		if err := <-errs; err != nil {
			t.Fatalf("並發退房不得出錯：%v", err)
		}
	}
	var remain int
	if err := pool.QueryRow(ctx, `select count(*) from rooms where id = $1`, roomID).Scan(&remain); err != nil {
		t.Fatal(err)
	}
	if remain != 0 {
		t.Fatal("並發雙退後房間應恰被刪除一次、零殘留")
	}
}

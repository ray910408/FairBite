package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
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

func TestLeaveEndpointRequiresAuth(t *testing.T) {
	pool, _ := leaveTestPool(t)
	h := newTestApp(t, pool)
	r := httptest.NewRequest("POST", "/api/leave", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 got %d", w.Code)
	}
}

// 有 membership 的使用者打 /api/leave：多房（殘留舊房自癒情境）一次退光並回 200；
// 再打一次仍 200（冪等）。雙房驗迴圈（eng review 5A）。
func TestLeaveEndpointLeavesAllRooms(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const uid = "aaaaaaaa-cccc-4ccc-8ccc-aaaaaaaaaaaa"
	const roomID = "bbbbbbbb-cccc-4ccc-8ccc-bbbbbbbbbbbb"
	const staleRoomID = "cccccccc-cccc-4ccc-8ccc-cccccccccccc"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id in ($1, $2)`, roomID, staleRoomID)
		pool.Exec(context.Background(), `delete from auth.users where id = $1`, uid)
	})
	if _, err := pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'leave-api@test.dev')`, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, host_id, status)
		values ($1, $3, 'lobby'), ($2, $3, 'lobby')`, roomID, staleRoomID, uid); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_members (room_id, user_id)
		values ($1, $3), ($2, $3)`, roomID, staleRoomID, uid); err != nil {
		t.Fatal(err)
	}
	h := newTestApp(t, pool)
	call := func() int {
		r := httptest.NewRequest("POST", "/api/leave", nil)
		r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", uid))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w.Code
	}
	if code := call(); code != http.StatusOK {
		t.Fatalf("leave want 200 got %d", code)
	}
	var roomCount int
	if err := pool.QueryRow(ctx, `select count(*) from rooms where id in ($1, $2)`, roomID, staleRoomID).Scan(&roomCount); err != nil {
		t.Fatal(err)
	}
	if roomCount != 0 {
		t.Fatal("兩間房（含殘留舊房）都應在一次呼叫退光刪除")
	}
	if code := call(); code != http.StatusOK {
		t.Fatalf("無 membership 的重複呼叫應冪等 200，got %d", code)
	}
}

// eng review 3A 回歸：membership 在 loadMemberRoom 檢查後被退房刪除 → 交易內
// 權威重驗必須擋下，否則孤兒否決永久毒化轉盤（離席者無法收回）。
func TestVoteAfterLeaveRejectedNoOrphanVote(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "cccccccc-dddd-4ddd-8ddd-cccccccccccc"
	const memberB = "dddddddd-dddd-4ddd-8ddd-dddddddddddd"
	const roomID = "eeeeeeee-dddd-4ddd-8ddd-eeeeeeeeeeee"
	const restaurantID = "ffffffff-dddd-4ddd-8ddd-ffffffffffff"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from restaurants where id = $1`, restaurantID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2)`, host, memberB)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'orphan-host@test.dev'), ($2,'orphan-b@test.dev')`, host, memberB); err != nil {
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
		values ($1, 'orphan-test-1', '孤兒票測試店', '["japanese"]', 1, 25.0478, 121.5171,
			'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}',
			'google')`, restaurantID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_candidates
		(room_id, restaurant_id, status, probability, exposure_counted)
		values ($1, $2, 'kept', 1, false)`, roomID, restaurantID); err != nil {
		t.Fatal(err)
	}

	// B 先退房，再以殘存 JWT 投否決——模擬「檢查後、寫票前退房」競態的落點狀態
	if err := leaveOneRoom(ctx, pool, nil, roomID, memberB); err != nil {
		t.Fatal(err)
	}
	h := newTestApp(t, pool)
	body := strings.NewReader(`{"restaurant_id":"` + restaurantID + `","kind":"veto","op":"cast"}`)
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/vote", body)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", memberB))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("已退房者投票應 403：got %d", w.Code)
	}
	var orphans int
	if err := pool.QueryRow(ctx, `select count(*) from votes
		where room_id = $1 and user_id = $2`, roomID, memberB).Scan(&orphans); err != nil {
		t.Fatal(err)
	}
	if orphans != 0 {
		t.Fatal("不得留下孤兒票")
	}
}

// eng review 3A/D11：決定性重現競態——外層檢查通過時 B 還在，寫票交易開始前
// B 已退房 commit。castVote 的交易內權威檢查必須回 ErrNotMember。
func TestCastVoteAfterConcurrentLeaveReturnsErrNotMember(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "12121212-eeee-4eee-8eee-121212121212"
	const memberB = "34343434-eeee-4eee-8eee-343434343434"
	const roomID = "56565656-eeee-4eee-8eee-565656565656"
	const restaurantID = "78787878-eeee-4eee-8eee-787878787878"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from restaurants where id = $1`, restaurantID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2)`, host, memberB)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'race-host@test.dev'), ($2,'race-b@test.dev')`, host, memberB); err != nil {
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
		values ($1, 'race-test-1', '競態測試店', '["japanese"]', 1, 25.0478, 121.5171,
			'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}',
			'google')`, restaurantID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_candidates
		(room_id, restaurant_id, status, probability, exposure_counted)
		values ($1, $2, 'kept', 1, false)`, roomID, restaurantID); err != nil {
		t.Fatal(err)
	}

	// 外層檢查等值：此刻 B 仍是成員
	var isMember bool
	if err := pool.QueryRow(ctx, `select exists (select 1 from room_members
		where room_id = $1 and user_id = $2)`, roomID, memberB).Scan(&isMember); err != nil {
		t.Fatal(err)
	}
	if !isMember {
		t.Fatal("前置：B 應為成員")
	}
	// 競態落點：B 的退房在寫票交易開始前 commit
	if err := leaveOneRoom(ctx, pool, nil, roomID, memberB); err != nil {
		t.Fatal(err)
	}
	// 寫票交易（比照 handleVote 的交易內順序）
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if err := TransitionRoom(ctx, tx, roomID, "voting", "voting"); err != nil {
		t.Fatal(err)
	}
	_, err = castVote(ctx, tx, roomID, memberB,
		VoteCommand{RestaurantID: restaurantID, Kind: "veto", Op: "cast"})
	if !errors.Is(err, ErrNotMember) {
		t.Fatalf("交易內權威檢查應回 ErrNotMember：got %v", err)
	}
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
	if _, err := pool.Exec(ctx, `insert into votes (room_id, user_id, restaurant_id, kind)
		values ($1, $2, $3, 'up')`, roomID, host, restaurantID); err != nil {
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
	var hostVotes int
	if err := pool.QueryRow(ctx, `select count(*) from votes
		where room_id = $1 and user_id = $2`, roomID, host).Scan(&hostVotes); err != nil {
		t.Fatal(err)
	}
	if hostVotes != 1 {
		t.Fatalf("退房只能刪退出者的票，host 的票應存活：got %d, want 1", hostVotes)
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

// PR #16 review P1 回歸：search 的 Places 呼叫期間房主退房（繼任發生），
// freeze 交易鎖內必須重驗 host_id 並拒絕前房主推進房間。
type hostLeavingProvider struct {
	pool   *pgxpool.Pool
	roomID string
	uid    string
	inner  PlacesProvider
	afterLeave func(context.Context) error
}

func (p hostLeavingProvider) Source() string { return "mock" }

func (p hostLeavingProvider) SearchNearby(ctx context.Context, lat, lng float64, radiusM int, cuisines []string) (PlacesSearchResult, error) {
	if err := leaveOneRoom(ctx, p.pool, nil, p.roomID, p.uid); err != nil {
		return PlacesSearchResult{}, err
	}
	if p.afterLeave != nil {
		if err := p.afterLeave(ctx); err != nil {
			return PlacesSearchResult{}, err
		}
	}
	return p.inner.SearchNearby(ctx, lat, lng, radiusM, cuisines)
}

func TestSearchAfterHostLeaveMidFlightRejected(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "77777777-abab-4bab-8bab-777777777777"
	const memberB = "88888888-abab-4bab-8bab-888888888888"
	const roomID = "99999999-abab-4bab-8bab-999999999999"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2)`, host, memberB)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'midflight-host@test.dev'), ($2,'midflight-b@test.dev')`, host, memberB); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 25.0478, 121.5170)`, roomID, host); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_members (room_id, user_id, joined_at, ready) values
		($1, $2, now() - interval '1 minute', false), ($1, $3, now(), true)`, roomID, host, memberB); err != nil {
		t.Fatal(err)
	}
	h := newTestAppWithProvider(t, pool,
		hostLeavingProvider{pool: pool, roomID: roomID, uid: host, inner: NewMockProvider()})
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", host))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("繼任後前房主的 in-flight search 應 403：got %d body=%s", w.Code, w.Body.String())
	}
	var status, hostID string
	if err := pool.QueryRow(ctx, `select status, host_id from rooms where id = $1`, roomID).
		Scan(&status, &hostID); err != nil {
		t.Fatal(err)
	}
	if status != "lobby" {
		t.Fatalf("房間不得被前房主推進：status = %s, want lobby", status)
	}
	if hostID != memberB {
		t.Fatalf("繼任結果不得被覆寫：host_id = %s, want %s", hostID, memberB)
	}
}

func TestSearchAfterHostLeaveMidFlightForbiddenBeforeReadiness(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "17777777-abab-4bab-8bab-777777777777"
	const memberB = "18888888-abab-4bab-8bab-888888888888"
	const memberC = "19999999-abab-4bab-8bab-999999999999"
	const roomID = "20000000-abab-4bab-8bab-000000000000"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2,$3)`, host, memberB, memberC)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'midflight-priority-host@test.dev'), ($2,'midflight-priority-b@test.dev'),
		($3,'midflight-priority-c@test.dev')`, host, memberB, memberC); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 25.0478, 121.5170)`, roomID, host); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_members (room_id, user_id, joined_at, ready) values
		($1, $2, now() - interval '2 minutes', false),
		($1, $3, now() - interval '1 minute', true),
		($1, $4, now(), true)`, roomID, host, memberB, memberC); err != nil {
		t.Fatal(err)
	}
	h := newTestAppWithProvider(t, pool, hostLeavingProvider{
		pool: pool, roomID: roomID, uid: host, inner: NewMockProvider(),
		afterLeave: func(ctx context.Context) error {
			_, err := pool.Exec(ctx, `update room_members set ready = false where room_id = $1 and user_id = $2`, roomID, memberC)
			return err
		},
	})
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", host))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusForbidden {
		t.Fatalf("前房主失去權限應優先於 remaining guest readiness：got %d body=%s", w.Code, w.Body.String())
	}
}

type pausedSearchProvider struct {
	started chan<- struct{}
	release <-chan struct{}
	inner   PlacesProvider
}

func (p pausedSearchProvider) Source() string { return "mock" }

func (p pausedSearchProvider) SearchNearby(ctx context.Context, lat, lng float64, radiusM int, cuisines []string) (PlacesSearchResult, error) {
	close(p.started)
	select {
	case <-p.release:
		return p.inner.SearchNearby(ctx, lat, lng, radiusM, cuisines)
	case <-ctx.Done():
		return PlacesSearchResult{}, ctx.Err()
	}
}

func TestSearchHostValidationHoldsRoomLockThroughTransition(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "30000000-abab-4bab-8bab-000000000001"
	const successor = "30000000-abab-4bab-8bab-000000000002"
	const roomID = "30000000-abab-4bab-8bab-000000000003"
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id = $1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id in ($1,$2)`, host, successor)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values
		($1,'host-lock-window@test.dev'), ($2,'successor-lock-window@test.dev')`, host, successor); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 25.0478, 121.5170)`, roomID, host); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_members (room_id, user_id, joined_at, ready) values
		($1, $2, now() - interval '1 minute', false), ($1, $3, now(), true)`, roomID, host, successor); err != nil {
		t.Fatal(err)
	}

	// 未 commit 的繼任交易先持有 rooms row lock；READ COMMITTED plain SELECT 仍會讀到舊 host。
	succession, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer succession.Rollback(ctx)
	if _, err := succession.Exec(ctx, `select id from rooms where id = $1 for update`, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := succession.Exec(ctx, `delete from room_members where room_id = $1 and user_id = $2`, roomID, host); err != nil {
		t.Fatal(err)
	}
	if _, err := succession.Exec(ctx, `update rooms set host_id = $2 where id = $1`, roomID, successor); err != nil {
		t.Fatal(err)
	}

	providerStarted := make(chan struct{})
	releaseProvider := make(chan struct{})
	h := newTestAppWithProvider(t, pool, pausedSearchProvider{
		started: providerStarted, release: releaseProvider, inner: NewMockProvider(),
	})
	token := signHS256(t, "test-secret-test-secret-test-secret!", host)
	done := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		done <- w
	}()
	<-providerStarted
	close(releaseProvider)

	// 不用 sleep 猜時序：等 search backend 確實卡在 rooms row lock，再 commit 繼任。
	ticker := time.NewTicker(10 * time.Millisecond)
	defer ticker.Stop()
	for {
		var waiting bool
		if err := pool.QueryRow(ctx, `select exists (
			select 1 from pg_stat_activity
			where datname = current_database() and pid <> pg_backend_pid()
			  and wait_event_type = 'Lock' and query ilike '%rooms%'
		)`).Scan(&waiting); err != nil {
			t.Fatal(err)
		}
		if waiting {
			break
		}
		select {
		case <-ctx.Done():
			t.Fatal("search 未進入 rooms row-lock wait")
		case <-ticker.C:
		}
	}
	if err := succession.Commit(ctx); err != nil {
		t.Fatal(err)
	}
	w := <-done
	if w.Code != http.StatusForbidden {
		t.Fatalf("host 驗證與轉場必須共用 room lock：got %d body=%s", w.Code, w.Body.String())
	}
	var status, hostID string
	if err := pool.QueryRow(ctx, `select status, host_id from rooms where id = $1`, roomID).Scan(&status, &hostID); err != nil {
		t.Fatal(err)
	}
	if status != "lobby" || hostID != successor {
		t.Fatalf("former host 不得轉場：status=%s host_id=%s", status, hostID)
	}
}

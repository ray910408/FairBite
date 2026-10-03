package main

import (
	"context"
	"encoding/json"
	"fmt"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

// seedShortlistRoom：members 位成員（users[0] 為房主），kept 家通過硬過濾的候選
// （24h 營業、價位在預算內、google 來源）——開始投票與退房會重算，候選必須是真餐廳列。
func seedShortlistRoom(t *testing.T, status string, members, kept int) (*pgxpool.Pool, string, []string, []string) {
	t.Helper()
	pool, ctx := leaveTestPool(t)
	users := make([]string, members)
	for i := range users {
		if err := pool.QueryRow(ctx, `insert into auth.users(id,email)
			values(gen_random_uuid(),gen_random_uuid()::text || '@test.dev') returning id`).Scan(&users[i]); err != nil {
			t.Fatal(err)
		}
	}
	var roomID string
	if err := pool.QueryRow(ctx, `insert into rooms(host_id,status,center_lat,center_lng)
		values($1,$2,25.0478,121.5170) returning id`, users[0], status).Scan(&roomID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		bg := context.Background()
		pool.Exec(bg, `delete from rooms where id=$1`, roomID)
		pool.Exec(bg, `delete from restaurants where place_id like $1`, "shortlist-"+roomID+"-%")
		pool.Exec(bg, `delete from auth.users where id=any($1::uuid[])`, users)
	})
	for i, uid := range users {
		if _, err := pool.Exec(ctx, `insert into room_members(room_id,user_id,budget_max,ready,joined_at)
			values($1,$2,500,true,now()+$3*interval '1 second')`, roomID, uid, i); err != nil {
			t.Fatal(err)
		}
	}
	restaurants := make([]string, kept)
	for i := range restaurants {
		if err := pool.QueryRow(ctx, `insert into restaurants(place_id,name,cuisine_tags,price_level,lat,lng,opening_hours,source)
			values($1,$2,'["japanese"]',1,25.0478,121.5171,
			'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}',
			'google') returning id`, fmt.Sprintf("shortlist-%s-%d", roomID, i), fmt.Sprint("Shortlist ", i)).Scan(&restaurants[i]); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `insert into room_candidates(room_id,restaurant_id,status,probability,exposure_counted)
			values($1,$2,'kept',$3,false)`, roomID, restaurants[i], 1.0/float64(kept)); err != nil {
			t.Fatal(err)
		}
	}
	return pool, roomID, users, restaurants
}

func shortlistCall(t *testing.T, pool *pgxpool.Pool, h func(http.ResponseWriter, *http.Request, *pgxpool.Pool),
	roomID, uid, body string, wantCode int) map[string]any {
	t.Helper()
	r := httptest.NewRequest("POST", "/", strings.NewReader(body))
	r.SetPathValue("id", roomID)
	r = r.WithContext(context.WithValue(r.Context(), userIDKey, uid))
	w := httptest.NewRecorder()
	h(w, r, pool)
	if w.Code != wantCode {
		t.Fatalf("body %s: want %d got %d: %s", body, wantCode, w.Code, w.Body.String())
	}
	out := map[string]any{}
	json.Unmarshal(w.Body.Bytes(), &out)
	return out
}

func startVotingNoWeather(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	handleStartVoting(w, r, pool, nil)
}

func shortlistCount(t *testing.T, pool *pgxpool.Pool, query string, args ...any) int {
	t.Helper()
	var n int
	if err := pool.QueryRow(context.Background(), query, args...).Scan(&n); err != nil {
		t.Fatal(err)
	}
	return n
}

func shortlistStatus(t *testing.T, pool *pgxpool.Pool, roomID string) string {
	t.Helper()
	var s string
	if err := pool.QueryRow(context.Background(), `select status from rooms where id=$1`, roomID).Scan(&s); err != nil {
		t.Fatal(err)
	}
	return s
}

func castPicks(t *testing.T, pool *pgxpool.Pool, roomID, uid string, restaurants ...string) {
	t.Helper()
	for _, rid := range restaurants {
		shortlistCall(t, pool, handlePick, roomID, uid, `{"restaurant_id":"`+rid+`","op":"cast","version":0}`, 200)
	}
}

func TestShortlistVoteGateAndStrictMajority(t *testing.T) {
	pool, roomID, users, _ := seedShortlistRoom(t, "candidates", 3, 10)
	// 房間在第 0 輪搜尋：別輪的 version 是舊畫面送來的，不得寫入
	shortlistCall(t, pool, handleShortlistVote, roomID, users[0], `{"want":true,"version":1}`, 409)
	if n := shortlistCount(t, pool, `select count(*) from shortlist_votes where room_id=$1`, roomID); n != 0 {
		t.Fatalf("stale version wrote %d votes", n)
	}
	if got := shortlistCall(t, pool, handleShortlistVote, roomID, users[0], `{"want":true,"version":0}`, 200)["status"]; got != "candidates" {
		t.Fatalf("1 of 3 is not a strict majority: %v", got)
	}
	if got := shortlistCall(t, pool, handleShortlistVote, roomID, users[1], `{"want":true,"version":0}`, 200)["status"]; got != "shortlisting" {
		t.Fatalf("2 of 3 must open the shortlist: %v", got)
	}
	if s := shortlistStatus(t, pool, roomID); s != "shortlisting" {
		t.Fatalf("status=%s", s)
	}
	shortlistCall(t, pool, handleShortlistVote, roomID, users[2], `{"want":true,"version":0}`, 409)
	shortlistCall(t, pool, handleShortlistVote, roomID, users[0], `{"want":false,"version":0}`, 409)
}

func TestShortlistVoteGateClosedAndMembership(t *testing.T) {
	pool, roomID, users, _ := seedShortlistRoom(t, "candidates", 3, 9)
	shortlistCall(t, pool, handleShortlistVote, roomID, users[0], `{"want":true,"version":0}`, 409)
	if n := shortlistCount(t, pool, `select count(*) from shortlist_votes where room_id=$1`, roomID); n != 0 {
		t.Fatalf("closed gate wrote %d votes", n)
	}
	shortlistCall(t, pool, handleShortlistVote, roomID, "00000000-0000-0000-0000-000000000001", `{"want":true,"version":0}`, 403)
	shortlistCall(t, pool, handleShortlistVote, roomID, users[0], `{}`, 400)
}

func TestShortlistPicks(t *testing.T) {
	pool, roomID, users, rs := seedShortlistRoom(t, "shortlisting", 3, 10)
	if _, err := pool.Exec(context.Background(), `update room_candidates set status='excluded',probability=null
		where room_id=$1 and restaurant_id=$2`, roomID, rs[9]); err != nil {
		t.Fatal(err)
	}
	pick := func(uid, rid, op string, code int) any {
		t.Helper()
		return shortlistCall(t, pool, handlePick, roomID, uid, `{"restaurant_id":"`+rid+`","op":"`+op+`","version":0}`, code)["picks"]
	}
	shortlistCall(t, pool, handlePick, roomID, users[0], `{"restaurant_id":"`+rs[0]+`","op":"cast","version":1}`, 409)
	if n := shortlistCount(t, pool, `select count(*) from shortlist_picks where room_id=$1`, roomID); n != 0 {
		t.Fatalf("stale version wrote %d picks", n)
	}
	for i := 0; i < ShortlistPickMax; i++ {
		if n := pick(users[0], rs[i], "cast", 200); n != float64(i+1) {
			t.Fatalf("cast %d: picks=%v", i, n)
		}
	}
	pick(users[0], rs[5], "cast", 409)
	if n := pick(users[0], rs[0], "cast", 200); n != float64(ShortlistPickMax) {
		t.Fatalf("idempotent re-cast at the cap: picks=%v", n)
	}
	if n := shortlistCount(t, pool, `select count(*) from shortlist_picks where room_id=$1 and user_id=$2`, roomID, users[0]); n != ShortlistPickMax {
		t.Fatalf("stored picks=%d", n)
	}
	pick(users[1], rs[9], "cast", 409)
	if n := pick(users[0], rs[0], "retract", 200); n != float64(ShortlistPickMax-1) {
		t.Fatalf("retract: picks=%v", n)
	}
	shortlistCall(t, pool, handlePick, roomID, users[0], `{"restaurant_id":"`+rs[0]+`","op":"toggle","version":0}`, 400)
	shortlistCall(t, pool, handlePick, roomID, "00000000-0000-0000-0000-000000000001",
		`{"restaurant_id":"`+rs[0]+`","op":"cast","version":0}`, 403)
	if _, err := pool.Exec(context.Background(), `update rooms set status='candidates' where id=$1`, roomID); err != nil {
		t.Fatal(err)
	}
	pick(users[1], rs[1], "cast", 409)
}

func TestShortlistStartVotingFreezesUnpicked(t *testing.T) {
	pool, roomID, users, rs := seedShortlistRoom(t, "shortlisting", 3, 10)
	shortlistCall(t, pool, startVotingNoWeather, roomID, users[1], "", 403)
	castPicks(t, pool, roomID, users[0], rs[0], rs[1], rs[2])
	castPicks(t, pool, roomID, users[1], rs[0], rs[1], rs[3])
	castPicks(t, pool, roomID, users[2], rs[0], rs[1])
	shortlistCall(t, pool, startVotingNoWeather, roomID, users[0], "", 409)
	if s := shortlistStatus(t, pool, roomID); s != "shortlisting" {
		t.Fatalf("unfinished picks changed status to %s", s)
	}
	if n := shortlistCount(t, pool, `select count(*) from room_candidates where room_id=$1 and shortlist_excluded`, roomID); n != 0 {
		t.Fatalf("rejected start froze %d candidates", n)
	}
	castPicks(t, pool, roomID, users[2], rs[4])
	shortlistCall(t, pool, startVotingNoWeather, roomID, users[0], "", 200)
	if s := shortlistStatus(t, pool, roomID); s != "voting" {
		t.Fatalf("status=%s", s)
	}
	assertShortlistSplit(t, pool, roomID, rs, map[int]bool{0: true, 1: true, 2: true, 3: true, 4: true})
}

// 圈選後入圍店全數打烊：開始投票回 409，轉態與落選定案隨交易回滾
func TestShortlistStartVotingRejectsAllPickedClosed(t *testing.T) {
	pool, roomID, users, rs := seedShortlistRoom(t, "shortlisting", 3, 10)
	for _, uid := range users {
		castPicks(t, pool, roomID, uid, rs[0], rs[1], rs[2])
	}
	// 七天都沒有營業時段：任何評估時間都打烊；未圈選的 24h 店仍營業
	if _, err := pool.Exec(context.Background(), `update restaurants
		set opening_hours='{"sun":[],"mon":[],"tue":[],"wed":[],"thu":[],"fri":[],"sat":[]}'
		where id=any($1::uuid[])`, rs[:3]); err != nil {
		t.Fatal(err)
	}
	if got := shortlistCall(t, pool, startVotingNoWeather, roomID, users[0], "", 409)["error"]; got != "入圍的店都已不在候選中（可能已打烊），請取消初選或修改條件" {
		t.Fatalf("error=%v", got)
	}
	if s := shortlistStatus(t, pool, roomID); s != "shortlisting" {
		t.Fatalf("status=%s", s)
	}
	if n := shortlistCount(t, pool, `select count(*) from room_candidates where room_id=$1 and shortlist_excluded`, roomID); n != 0 {
		t.Fatalf("rejected start froze %d candidates", n)
	}
}

// assertShortlistSplit：picked 留 kept，其餘是 shortlist 排除，kept 機率重新正規化
func assertShortlistSplit(t *testing.T, pool *pgxpool.Pool, roomID string, rs []string, picked map[int]bool) {
	t.Helper()
	for i, rid := range rs {
		var status string
		var flagged, kind bool
		if err := pool.QueryRow(context.Background(), `select status, shortlist_excluded, 'shortlist' = any(exclusion_kinds)
			from room_candidates where room_id=$1 and restaurant_id=$2`, roomID, rid).Scan(&status, &flagged, &kind); err != nil {
			t.Fatal(err)
		}
		if picked[i] && (status != "kept" || flagged || kind) {
			t.Fatalf("picked #%d: status=%s flagged=%v kind=%v", i, status, flagged, kind)
		}
		if !picked[i] && (status != "excluded" || !flagged || !kind) {
			t.Fatalf("unpicked #%d: status=%s flagged=%v kind=%v", i, status, flagged, kind)
		}
	}
	var sum float64
	if err := pool.QueryRow(context.Background(), `select coalesce(sum(probability),0)::float8 from room_candidates
		where room_id=$1 and status='kept'`, roomID).Scan(&sum); err != nil {
		t.Fatal(err)
	}
	if math.Abs(sum-1) > 1e-9 {
		t.Fatalf("kept probabilities sum to %v", sum)
	}
}

// ADR-0010：開始投票時定案；之前退房者的圈選即刻作廢
func TestShortlistFreezeAndLeave(t *testing.T) {
	t.Run("frozen after voting starts", func(t *testing.T) {
		pool, roomID, users, rs := seedShortlistRoom(t, "shortlisting", 3, 10)
		castPicks(t, pool, roomID, users[0], rs[0], rs[1], rs[2])
		castPicks(t, pool, roomID, users[1], rs[0], rs[1], rs[2])
		castPicks(t, pool, roomID, users[2], rs[0], rs[1], rs[3])
		shortlistCall(t, pool, startVotingNoWeather, roomID, users[0], "", 200)
		if err := leaveOneRoom(context.Background(), pool, nil, roomID, users[2]); err != nil {
			t.Fatal(err)
		}
		assertShortlistSplit(t, pool, roomID, rs, map[int]bool{0: true, 1: true, 2: true, 3: true})
	})
	t.Run("leaver's picks void before voting", func(t *testing.T) {
		pool, roomID, users, rs := seedShortlistRoom(t, "shortlisting", 3, 10)
		castPicks(t, pool, roomID, users[0], rs[0], rs[1], rs[2])
		castPicks(t, pool, roomID, users[1], rs[0], rs[1], rs[2])
		castPicks(t, pool, roomID, users[2], rs[3], rs[4])
		shortlistCall(t, pool, startVotingNoWeather, roomID, users[0], "", 409)
		if err := leaveOneRoom(context.Background(), pool, nil, roomID, users[2]); err != nil {
			t.Fatal(err)
		}
		if n := shortlistCount(t, pool, `select count(*) from shortlist_picks where room_id=$1 and user_id=$2`, roomID, users[2]); n != 0 {
			t.Fatalf("leaver kept %d picks", n)
		}
		if s := shortlistStatus(t, pool, roomID); s != "shortlisting" {
			t.Fatalf("leave changed status to %s", s)
		}
		shortlistCall(t, pool, startVotingNoWeather, roomID, users[0], "", 200)
		assertShortlistSplit(t, pool, roomID, rs, map[int]bool{0: true, 1: true, 2: true})
	})
}

// seedShortlistState：兩位成員有初選表決、房主圈了一家
func seedShortlistState(t *testing.T, pool *pgxpool.Pool, roomID string, users, rs []string) {
	t.Helper()
	if _, err := pool.Exec(context.Background(), `insert into shortlist_votes(room_id,user_id)
		values($1,$2),($1,$3)`, roomID, users[0], users[1]); err != nil {
		t.Fatal(err)
	}
	castPicks(t, pool, roomID, users[0], rs[0])
}

func TestShortlistCancel(t *testing.T) {
	pool, roomID, users, rs := seedShortlistRoom(t, "shortlisting", 3, 10)
	seedShortlistState(t, pool, roomID, users, rs)
	shortlistCall(t, pool, handleCancelShortlist, roomID, users[1], "", 403)
	if got := shortlistCall(t, pool, handleCancelShortlist, roomID, users[0], "", 200)["status"]; got != "candidates" {
		t.Fatalf("cancel status=%v", got)
	}
	if s := shortlistStatus(t, pool, roomID); s != "candidates" {
		t.Fatalf("status=%s", s)
	}
	if n := shortlistCount(t, pool, `select
		(select count(*) from shortlist_picks where room_id=$1) +
		(select count(*) from shortlist_votes where room_id=$1) +
		(select count(*) from room_candidates where room_id=$1 and shortlist_excluded)`, roomID); n != 0 {
		t.Fatalf("cancel left %d picks/votes/exclusions", n)
	}
	shortlistCall(t, pool, handleCancelShortlist, roomID, users[0], "", 409)
}

func TestShortlistEditConditionsReturnsLobby(t *testing.T) {
	pool, roomID, users, rs := seedShortlistRoom(t, "shortlisting", 3, 10)
	seedShortlistState(t, pool, roomID, users, rs)
	shortlistCall(t, pool, handleEditConditions, roomID, users[0], "", 204)
	if s := shortlistStatus(t, pool, roomID); s != "lobby" {
		t.Fatalf("status=%s", s)
	}
	if n := shortlistCount(t, pool, `select
		(select count(*) from shortlist_picks where room_id=$1) +
		(select count(*) from shortlist_votes where room_id=$1)`, roomID); n != 0 {
		t.Fatalf("edit-conditions left %d picks/votes", n)
	}
}

func TestShortlistMajorityRecountsThroughLeave(t *testing.T) {
	for _, leaveYes := range []bool{false, true} {
		t.Run(fmt.Sprint(leaveYes), func(t *testing.T) {
			// 4 人門檻 > 12、3 人 > 9：13 家讓退房前後都開放
			pool, roomID, users, _ := seedShortlistRoom(t, "candidates", 4, 13)
			for _, uid := range users[:2] {
				shortlistCall(t, pool, handleShortlistVote, roomID, uid, `{"want":true,"version":0}`, 200)
			}
			if s := shortlistStatus(t, pool, roomID); s != "candidates" {
				t.Fatalf("2 of 4 is not a strict majority: %s", s)
			}
			leaver := users[3]
			if leaveYes {
				leaver = users[1]
			}
			if err := leaveOneRoom(context.Background(), pool, nil, roomID, leaver); err != nil {
				t.Fatal(err)
			}
			want := "shortlisting"
			if leaveYes {
				want = "candidates"
			}
			if s := shortlistStatus(t, pool, roomID); s != want {
				t.Fatalf("leaveYes=%v status=%s want=%s", leaveYes, s, want)
			}
		})
	}
}

func TestShortlistRoutes(t *testing.T) {
	pool, roomID, users, rs := seedShortlistRoom(t, "candidates", 1, 4)
	h := newTestApp(t, pool)
	for _, tc := range []struct{ path, body string }{
		{"shortlist-vote", `{"want":true,"version":0}`},
		{"pick", `{"restaurant_id":"` + rs[0] + `","op":"cast","version":0}`},
		{"cancel-shortlist", ""},
	} {
		if w := pendingPost(t, h, users[0], "/api/rooms/"+roomID+"/"+tc.path, tc.body); w.Code != http.StatusOK {
			t.Fatalf("%s route=%d %s", tc.path, w.Code, w.Body.String())
		}
	}
}

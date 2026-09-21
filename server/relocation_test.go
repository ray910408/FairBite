package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

type relocatingSearchProvider struct {
	pool         *pgxpool.Pool
	roomID       string
	fail         bool
	relocate     bool
	changeCenter bool
}

func (relocatingSearchProvider) Source() string { return "mock" }

func (p relocatingSearchProvider) SearchNearby(ctx context.Context, _, _ float64, _ int, _ []string) (PlacesSearchResult, error) {
	if p.relocate {
		if _, err := p.pool.Exec(ctx, `update rooms
			set search_version=search_version+1,
			center_lat=case when $2 then -49 else center_lat end
			where id=$1`, p.roomID, p.changeCenter); err != nil {
			return PlacesSearchResult{}, err
		}
	}
	if p.fail {
		return PlacesSearchResult{}, errors.New("simulated outage after relocation")
	}
	return PlacesSearchResult{}, nil
}

func seedLocationRoom(t *testing.T, count int) (*pgxpool.Pool, string, []string) {
	t.Helper()
	pool, ctx := leaveTestPool(t)
	var roomID string
	users := make([]string, count)
	for i := range users {
		if err := pool.QueryRow(ctx, `insert into auth.users(id,email)
			values(gen_random_uuid(),gen_random_uuid()::text || '@test.dev') returning id`).Scan(&users[i]); err != nil {
			t.Fatal(err)
		}
	}
	if err := pool.QueryRow(ctx, `insert into rooms(host_id,status,center_lat,center_lng)
		values($1,'voting',25.05,121.52) returning id`, users[0]).Scan(&roomID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(context.Background(), `delete from rooms where id=$1`, roomID)
		pool.Exec(context.Background(), `delete from auth.users where id=any($1::uuid[])`, users)
	})
	for i, uid := range users {
		if _, err := pool.Exec(ctx, `insert into room_members(room_id,user_id,budget_max,ready,joined_at)
			values($1,$2,800,true,now()+$3*interval '1 second')`, roomID, uid, i); err != nil {
			t.Fatal(err)
		}
	}
	return pool, roomID, users
}

func locationRequest(pool *pgxpool.Pool, roomID, uid, body string, choose bool) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/", strings.NewReader(body))
	r.SetPathValue("id", roomID)
	r = r.WithContext(context.WithValue(r.Context(), userIDKey, uid))
	w := httptest.NewRecorder()
	if choose {
		handleChooseLocation(w, r, pool)
	} else {
		handleLocationVote(w, r, pool)
	}
	return w
}

func TestLocationMajorityAndReset(t *testing.T) {
	pool, roomID, users := seedLocationRoom(t, 4)
	call := func(uid, body string, wantCode int, choose bool) {
		t.Helper()
		w := locationRequest(pool, roomID, uid, body, choose)
		if w.Code != wantCode {
			t.Fatalf("want %d got %d: %s", wantCode, w.Code, w.Body.String())
		}
	}
	status := func(want string) {
		t.Helper()
		var got string
		if err := pool.QueryRow(context.Background(), `select status from rooms where id=$1`, roomID).Scan(&got); err != nil {
			t.Fatal(err)
		}
		if got != want {
			t.Fatalf("want status %s got %s", want, got)
		}
	}
	call(users[0], `{"want":true,"version":0}`, 200, false)
	call(users[1], `{"want":true,"version":0}`, 200, false)
	status("voting")
	call(users[1], `{"want":false,"version":0}`, 200, false)
	call(users[2], `{"want":true,"version":0}`, 200, false)
	status("voting")
	call(users[1], `{"want":true,"version":0}`, 200, false)
	status("relocating")
	call(users[1], `{"want":false,"version":0}`, 409, false)
	call(users[1], `{"lat":25.1,"lng":121.6,"version":0}`, 403, true)
	call(users[0], `{"lat":25.1,"lng":121.6,"version":0}`, 200, true)
	status("lobby")
	var votes, ready, members, version int
	var lat, lng float64
	err := pool.QueryRow(context.Background(), `select
		(select count(*) from location_change_votes where room_id=$1),
		(select count(*) from room_members where room_id=$1 and ready),
		(select count(*) from room_members where room_id=$1 and budget_max=800),
		search_version,center_lat,center_lng from rooms where id=$1`, roomID).
		Scan(&votes, &ready, &members, &version, &lat, &lng)
	if err != nil {
		t.Fatal(err)
	}
	if votes != 0 || ready != 0 || members != 4 || version != 1 || lat != 25.1 || lng != 121.6 {
		t.Fatalf("incorrect reset: votes=%d ready=%d members=%d version=%d center=%v,%v", votes, ready, members, version, lat, lng)
	}
	call(users[0], `{"lat":25.2,"lng":121.7,"version":0}`, 409, true)
	call(users[0], `{"lat":25.1,"lng":121.6,"version":1}`, 200, true)
	if err := pool.QueryRow(context.Background(), `select search_version from rooms where id=$1`, roomID).Scan(&version); err != nil {
		t.Fatal(err)
	}
	if version != 2 {
		t.Fatalf("same-center selection must invalidate an in-flight search: %d", version)
	}
}

func TestLocationCommandsValidateMembershipAndCoordinates(t *testing.T) {
	pool, roomID, users := seedLocationRoom(t, 1)
	for _, tc := range []struct {
		body   string
		choose bool
	}{
		{`{"version":0}`, false}, {`{"want":true}`, false},
		{`{"lat":91,"lng":0,"version":0}`, true}, {`{"lat":0,"version":0}`, true},
	} {
		if w := locationRequest(pool, roomID, users[0], tc.body, tc.choose); w.Code != 400 {
			t.Fatalf("%s got %d", tc.body, w.Code)
		}
	}
	if w := locationRequest(pool, roomID, "00000000-0000-0000-0000-000000000001", `{"want":true,"version":0}`, false); w.Code != 403 {
		t.Fatalf("outsider got %d", w.Code)
	}
}

func TestLocationRoutes(t *testing.T) {
	pool, roomID, users := seedLocationRoom(t, 1)
	h := newTestApp(t, pool)
	vote := pendingPost(t, h, users[0], "/api/rooms/"+roomID+"/location-vote", `{"want":true,"version":0}`)
	if vote.Code != http.StatusOK {
		t.Fatalf("vote route=%d %s", vote.Code, vote.Body.String())
	}
	choose := pendingPost(t, h, users[0], "/api/rooms/"+roomID+"/location", `{"lat":25.1,"lng":121.6,"version":0}`)
	if choose.Code != http.StatusOK {
		t.Fatalf("choose route=%d %s", choose.Code, choose.Body.String())
	}
}

func TestLocationSnapshotRejectsSameCenterNewRound(t *testing.T) {
	pool, roomID, _ := seedLocationRoom(t, 1)
	ctx := context.Background()
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(ctx)
	if _, err := tx.Exec(ctx, `update rooms set status='lobby' where id=$1`, roomID); err != nil {
		t.Fatal(err)
	}
	if err := checkSearchSnapshot(ctx, tx, roomID, 0, 25.05, 121.52); err != ErrSearchChanged {
		t.Fatalf("stale round: %v", err)
	}
	if err := checkSearchSnapshot(ctx, tx, roomID, 1, 25.05, 121.52); err != nil {
		t.Fatal(err)
	}
}

func TestHandleSearchRejectsSameCenterNewRound(t *testing.T) {
	pool, roomID, users := seedLocationRoom(t, 1)
	ctx := context.Background()
	if _, err := pool.Exec(ctx, `update rooms set status='lobby' where id=$1`, roomID); err != nil {
		t.Fatal(err)
	}

	started := make(chan struct{}, 1)
	release := make(chan struct{})
	h := newTestAppWithProvider(t, pool, pausedSearchProvider{
		started: started, release: release, inner: NewMockProvider(),
	})
	result := make(chan *httptest.ResponseRecorder, 1)
	go func() {
		result <- pendingPost(t, h, users[0], "/api/rooms/"+roomID+"/search", "")
	}()
	select {
	case <-started:
	case <-time.After(5 * time.Second):
		t.Fatal("search provider did not start")
	}

	choose := locationRequest(pool, roomID, users[0], `{"lat":25.05,"lng":121.52,"version":1}`, true)
	if choose.Code != http.StatusOK {
		t.Fatalf("same-center new round=%d %s", choose.Code, choose.Body.String())
	}
	close(release)

	var search *httptest.ResponseRecorder
	select {
	case search = <-result:
	case <-time.After(5 * time.Second):
		t.Fatal("search did not finish")
	}
	if search.Code != http.StatusConflict {
		t.Fatalf("stale search=%d %s", search.Code, search.Body.String())
	}
	var status string
	var candidates int
	if err := pool.QueryRow(ctx, `select status,(select count(*) from room_candidates where room_id=$1)
		from rooms where id=$1`, roomID).Scan(&status, &candidates); err != nil {
		t.Fatal(err)
	}
	if status != "lobby" || candidates != 0 {
		t.Fatalf("stale search adopted: status=%s candidates=%d", status, candidates)
	}
}

func TestHandleSearchRejectsRelocationBeforeEarlySearchExits(t *testing.T) {
	for _, tc := range []struct {
		name         string
		fail         bool
		relocate     bool
		changeCenter bool
		wantStatus   int
	}{
		{name: "unchanged empty result", wantStatus: http.StatusUnprocessableEntity},
		{name: "unchanged provider failure without cache", fail: true, wantStatus: http.StatusBadGateway},
		{name: "relocated empty result", relocate: true, changeCenter: true, wantStatus: http.StatusConflict},
		{name: "relocated provider failure without cache", fail: true, relocate: true, changeCenter: true, wantStatus: http.StatusConflict},
		{name: "same-center new round empty result", relocate: true, wantStatus: http.StatusConflict},
		{name: "same-center new round provider failure without cache", fail: true, relocate: true, wantStatus: http.StatusConflict},
	} {
		t.Run(tc.name, func(t *testing.T) {
			pool, roomID, users := seedLocationRoom(t, 1)
			ctx := context.Background()
			// Keep the cache-miss fixture away from the Taipei restaurant fixtures.
			if _, err := pool.Exec(ctx, `update rooms set status='lobby',center_lat=-50,center_lng=-140 where id=$1`, roomID); err != nil {
				t.Fatal(err)
			}
			members, err := LoadMembers(ctx, pool, roomID)
			if err != nil {
				t.Fatal(err)
			}
			cached, err := LoadCachedRestaurants(ctx, pool, -50, -140, averageMemberRadius(members), false)
			if err != nil || len(cached) != 0 {
				t.Fatalf("fixture must have no fallback cache: count=%d err=%v", len(cached), err)
			}

			h := newTestAppWithProvider(t, pool, relocatingSearchProvider{
				pool: pool, roomID: roomID, fail: tc.fail, relocate: tc.relocate, changeCenter: tc.changeCenter,
			})
			search := pendingPost(t, h, users[0], "/api/rooms/"+roomID+"/search", "")
			if search.Code != tc.wantStatus {
				t.Fatalf("want %d got %d %s", tc.wantStatus, search.Code, search.Body.String())
			}
			if tc.relocate && !strings.Contains(search.Body.String(), "搜尋位置已更新") {
				t.Fatalf("missing relocation message: %s", search.Body.String())
			}
			var status string
			var candidates int
			if err := pool.QueryRow(ctx, `select status,(select count(*) from room_candidates where room_id=$1)
				from rooms where id=$1`, roomID).Scan(&status, &candidates); err != nil {
				t.Fatal(err)
			}
			if status != "lobby" || candidates != 0 {
				t.Fatalf("early exit changed room: status=%s candidates=%d", status, candidates)
			}
		})
	}
}

func TestLocationMajorityRecountsCurrentMembers(t *testing.T) {
	for _, leaveYes := range []bool{false, true} {
		t.Run(fmt.Sprint(leaveYes), func(t *testing.T) {
			pool, roomID, users := seedLocationRoom(t, 4)
			for _, uid := range users[:2] {
				w := locationRequest(pool, roomID, uid, `{"want":true,"version":0}`, false)
				if w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			ctx := context.Background()
			tx, err := pool.Begin(ctx)
			if err != nil {
				t.Fatal(err)
			}
			defer tx.Rollback(ctx)
			if _, err := tx.Exec(ctx, `select id from rooms where id=$1 for update`, roomID); err != nil {
				t.Fatal(err)
			}
			uid := users[3]
			if leaveYes {
				uid = users[1]
			}
			if _, err := tx.Exec(ctx, `delete from room_members where room_id=$1 and user_id=$2`, roomID, uid); err != nil {
				t.Fatal(err)
			}
			passed, err := passLocationMajority(ctx, tx, roomID)
			if err != nil || passed == leaveYes {
				t.Fatalf("leaveYes=%v passed=%v err=%v", leaveYes, passed, err)
			}
		})
	}
}

func TestLocationMajorityRecountsThroughLeave(t *testing.T) {
	for _, leaveYes := range []bool{false, true} {
		t.Run(fmt.Sprint(leaveYes), func(t *testing.T) {
			pool, roomID, users := seedLocationRoom(t, 4)
			for _, uid := range users[:2] {
				if w := locationRequest(pool, roomID, uid, `{"want":true,"version":0}`, false); w.Code != 200 {
					t.Fatal(w.Body.String())
				}
			}
			leaver := users[3]
			if leaveYes {
				leaver = users[1]
			}
			if err := leaveOneRoom(context.Background(), pool, nil, roomID, leaver); err != nil {
				t.Fatal(err)
			}
			var status string
			if err := pool.QueryRow(context.Background(), `select status from rooms where id=$1`, roomID).Scan(&status); err != nil {
				t.Fatal(err)
			}
			want := "relocating"
			if leaveYes {
				want = "voting"
			}
			if status != want {
				t.Fatalf("leaveYes=%v status=%s want=%s", leaveYes, status, want)
			}
		})
	}
}

func TestLocationMajoritySerializesWithDraw(t *testing.T) {
	pool, roomID, users := seedLocationRoom(t, 3)
	ctx := context.Background()
	var restaurantID string
	if err := pool.QueryRow(ctx, `insert into restaurants(place_id,name,lat,lng,price_level,opening_hours,source)
		values(gen_random_uuid()::text,'Concurrent draw',25.05,121.52,1,
		'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}',
		'mock') returning id`).Scan(&restaurantID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from rooms where id=$1`, roomID)
		pool.Exec(ctx, `delete from restaurants where id=$1`, restaurantID)
	})
	if _, err := pool.Exec(ctx, `insert into room_candidates(room_id,restaurant_id,status,probability)
		values($1,$2,'kept',1)`, roomID, restaurantID); err != nil {
		t.Fatal(err)
	}
	if w := locationRequest(pool, roomID, users[0], `{"want":true,"version":0}`, false); w.Code != 200 {
		t.Fatal(w.Body.String())
	}
	h := newTestApp(t, pool)
	request := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/draw", nil)
	request.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", users[0]))
	start, results := make(chan struct{}), make(chan int, 2)
	go func() {
		<-start
		results <- locationRequest(pool, roomID, users[1], `{"want":true,"version":0}`, false).Code
	}()
	go func() { <-start; w := httptest.NewRecorder(); h.ServeHTTP(w, request); results <- w.Code }()
	close(start)
	one, two := <-results, <-results
	if !((one == 200 && two == 409) || (one == 409 && two == 200)) {
		t.Fatalf("competing actions: %d %d", one, two)
	}
	var status string
	var draws int
	if err := pool.QueryRow(ctx, `select status,(select count(*) from draws where room_id=$1) from rooms where id=$1`, roomID).Scan(&status, &draws); err != nil {
		t.Fatal(err)
	}
	if (status == "pending" && draws != 1) || (status == "relocating" && draws != 0) || (status != "pending" && status != "relocating") {
		t.Fatalf("inconsistent result: status=%s draws=%d", status, draws)
	}
}

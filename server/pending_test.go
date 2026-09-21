package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"testing"

	"github.com/jackc/pgx/v5/pgxpool"
)

func pendingPool(t *testing.T) (*pgxpool.Pool, context.Context) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run isolated Supabase")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool, ctx
}

func pendingPost(t *testing.T, h http.Handler, uid, path, body string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", uid))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func seedPendingRoom(t *testing.T, pool *pgxpool.Pool, ctx context.Context, roomID, hostID string, restaurants int) {
	t.Helper()
	if _, err := pool.Exec(ctx, `insert into auth.users(id,email) values($1,$2)`, hostID, hostID+"@test.dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into rooms(id,host_id,status,center_lat,center_lng)
		values($1,$2,'voting',25.0478,121.5170)`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_members(room_id,user_id,budget_max,cuisines,max_distance_m,transport,ready)
		values($1,$2,500,'["japanese"]',2000,'walking',true)`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < restaurants; i++ {
		id := fmt.Sprintf("%08d-aaaa-4aaa-8aaa-%012d", i+1, i+1)
		if _, err := pool.Exec(ctx, `insert into restaurants(id,place_id,name,cuisine_tags,price_level,lat,lng,opening_hours,source)
			values($1,$2,$3,'["japanese"]',1,25.0478,121.5171,
			'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}','google')`,
			id, "pending-place-"+roomID+fmt.Sprint(i), "Pending "+fmt.Sprint(i)); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx, `insert into room_candidates(room_id,restaurant_id,status,probability,exposure_counted)
			values($1,$2,'kept',$3,false)`, roomID, id, 1.0/float64(restaurants)); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from rooms where id=$1`, roomID)
		pool.Exec(ctx, `delete from auth.users where id=$1`, hostID)
		pool.Exec(ctx, `delete from restaurants where place_id like $1`, "pending-place-"+roomID+"%")
	})
}

func responseVersion(t *testing.T, w *httptest.ResponseRecorder) int64 {
	t.Helper()
	var body struct {
		Version int64 `json:"version"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	return body.Version
}

func TestPendingDrawRedrawConfirmLifecycle(t *testing.T) {
	pool, ctx := pendingPool(t)
	const roomID = "71717171-7171-4171-8171-717171717171"
	const hostID = "72727272-7272-4272-8272-727272727272"
	seedPendingRoom(t, pool, ctx, roomID, hostID, 2)
	h := newTestApp(t, pool)

	draw := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/draw", "")
	if draw.Code != 200 {
		t.Fatalf("draw=%d %s", draw.Code, draw.Body.String())
	}
	v1 := responseVersion(t, draw)
	var status string
	var history int
	if err := pool.QueryRow(ctx, `select status from rooms where id=$1`, roomID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from dining_history where room_id=$1`, roomID).Scan(&history); err != nil {
		t.Fatal(err)
	}
	if status != "pending" || history != 0 {
		t.Fatalf("draw status=%s history=%d", status, history)
	}

	redraw := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/redraw", fmt.Sprintf(`{"version":%d}`, v1))
	if redraw.Code != 200 {
		t.Fatalf("redraw=%d %s", redraw.Code, redraw.Body.String())
	}
	v2 := responseVersion(t, redraw)
	if v2 != v1+1 {
		t.Fatalf("version=%d want=%d", v2, v1+1)
	}
	var draws, excluded int
	if err := pool.QueryRow(ctx, `select count(*) from draws where room_id=$1`, roomID).Scan(&draws); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from room_candidates where room_id=$1 and batch_excluded`, roomID).Scan(&excluded); err != nil {
		t.Fatal(err)
	}
	if draws != 2 || excluded != 1 {
		t.Fatalf("draws=%d batch_excluded=%d", draws, excluded)
	}
	stale := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/redraw", fmt.Sprintf(`{"version":%d}`, v1))
	if stale.Code != http.StatusConflict {
		t.Fatalf("stale redraw=%d %s", stale.Code, stale.Body.String())
	}
	staleConfirm := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/confirm", fmt.Sprintf(`{"version":%d}`, v1))
	if staleConfirm.Code != http.StatusConflict {
		t.Fatalf("stale confirm=%d %s", staleConfirm.Code, staleConfirm.Body.String())
	}

	confirm := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/confirm", fmt.Sprintf(`{"version":%d}`, v2))
	if confirm.Code != 200 {
		t.Fatalf("confirm=%d %s", confirm.Code, confirm.Body.String())
	}
	if err := pool.QueryRow(ctx, `select count(*) from dining_history where room_id=$1`, roomID).Scan(&history); err != nil {
		t.Fatal(err)
	}
	if history != 1 {
		t.Fatalf("history=%d want=1", history)
	}
	retry := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/confirm", fmt.Sprintf(`{"version":%d}`, v2))
	if retry.Code != 200 {
		t.Fatalf("idempotent confirm=%d %s", retry.Code, retry.Body.String())
	}
	var after int
	if err := pool.QueryRow(ctx, `select count(*) from dining_history where room_id=$1`, roomID).Scan(&after); err != nil {
		t.Fatal(err)
	}
	if after != history {
		t.Fatalf("duplicate history=%d want=%d", after, history)
	}
}

func TestPendingExhaustionReturnsLobby(t *testing.T) {
	pool, ctx := pendingPool(t)
	const roomID = "73737373-7373-4373-8373-737373737373"
	const hostID = "74747474-7474-4474-8474-747474747474"
	seedPendingRoom(t, pool, ctx, roomID, hostID, 1)
	h := newTestApp(t, pool)
	draw := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/draw", "")
	v := responseVersion(t, draw)
	redraw := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/redraw", fmt.Sprintf(`{"version":%d}`, v))
	if redraw.Code != 200 {
		t.Fatalf("redraw=%d %s", redraw.Code, redraw.Body.String())
	}
	var status string
	var ready bool
	var candidates, audits int
	if err := pool.QueryRow(ctx, `select status from rooms where id=$1`, roomID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select ready from room_members where room_id=$1`, roomID).Scan(&ready); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from room_candidates where room_id=$1`, roomID).Scan(&candidates); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from draws where room_id=$1`, roomID).Scan(&audits); err != nil {
		t.Fatal(err)
	}
	if status != "lobby" || ready || candidates != 0 || audits != 1 {
		t.Fatalf("status=%s ready=%v candidates=%d audits=%d", status, ready, candidates, audits)
	}
}

func TestPendingConfirmExhaustionReturnsLobby(t *testing.T) {
	pool, ctx := pendingPool(t)
	const roomID = "85858585-8585-4585-8585-858585858585"
	const hostID = "86868686-8686-4686-8686-868686868686"
	seedPendingRoom(t, pool, ctx, roomID, hostID, 1)
	h := newTestApp(t, pool)
	draw := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/draw", "")
	version := responseVersion(t, draw)
	var winner string
	if err := pool.QueryRow(ctx, `select winner_restaurant_id from draws where room_id=$1 and version=$2`, roomID, version).Scan(&winner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into votes(room_id,user_id,restaurant_id,kind) values($1,$2,$3,'up')`, roomID, hostID, winner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update restaurants set price_level=4 where id=$1`, winner); err != nil {
		t.Fatal(err)
	}

	confirm := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/confirm", fmt.Sprintf(`{"version":%d}`, version))
	if confirm.Code != http.StatusOK {
		t.Fatalf("confirm=%d %s", confirm.Code, confirm.Body.String())
	}
	var response struct {
		Status    string `json:"status"`
		Exhausted bool   `json:"exhausted"`
	}
	if err := json.Unmarshal(confirm.Body.Bytes(), &response); err != nil {
		t.Fatal(err)
	}
	if response.Status != "lobby" || !response.Exhausted {
		t.Fatalf("response=%+v", response)
	}

	var status, transport string
	var ready bool
	var budget, distance, members, candidates, votes, history, audits int
	var cuisines []string
	if err := pool.QueryRow(ctx, `select status from rooms where id=$1`, roomID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select budget_max,cuisines,max_distance_m,transport,ready
		from room_members where room_id=$1 and user_id=$2`, roomID, hostID).
		Scan(&budget, &cuisines, &distance, &transport, &ready); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select count(*) from room_members where room_id=$1`, roomID).Scan(&members); err != nil {
		t.Fatal(err)
	}
	for query, dest := range map[string]*int{
		`select count(*) from room_candidates where room_id=$1`: &candidates,
		`select count(*) from votes where room_id=$1`:           &votes,
		`select count(*) from dining_history where room_id=$1`:  &history,
		`select count(*) from draws where room_id=$1`:           &audits,
	} {
		if err := pool.QueryRow(ctx, query, roomID).Scan(dest); err != nil {
			t.Fatal(err)
		}
	}
	if status != "lobby" || ready || candidates != 0 || votes != 0 || history != 0 || audits != 1 {
		t.Fatalf("status=%s ready=%v candidates=%d votes=%d history=%d audits=%d",
			status, ready, candidates, votes, history, audits)
	}
	if members != 1 || budget != 500 || len(cuisines) != 1 || cuisines[0] != "japanese" || distance != 2000 || transport != "walking" {
		t.Fatalf("membership changed: members=%d budget=%d cuisines=%v distance=%d transport=%s",
			members, budget, cuisines, distance, transport)
	}
}

func addPendingMember(t *testing.T, pool *pgxpool.Pool, ctx context.Context, roomID, userID string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `insert into auth.users(id,email) values($1,$2) on conflict(id) do nothing`, userID, userID+"@test.dev"); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into room_members(room_id,user_id,budget_max,cuisines,max_distance_m,transport,ready)
		values($1,$2,500,'["japanese"]',2000,'walking',true)`, roomID, userID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from room_members where room_id=$1 and user_id=$2`, roomID, userID)
		pool.Exec(ctx, `delete from auth.users where id=$1`, userID)
	})
}

func TestPendingPermissionsAndHostSuccessor(t *testing.T) {
	pool, ctx := pendingPool(t)
	const roomID = "75757575-7575-4575-8575-757575757575"
	const hostID = "76767676-7676-4676-8676-767676767676"
	const memberID = "77777777-7777-4777-8777-777777777777"
	seedPendingRoom(t, pool, ctx, roomID, hostID, 2)
	addPendingMember(t, pool, ctx, roomID, memberID)
	h := newTestApp(t, pool)
	draw := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/draw", "")
	v := responseVersion(t, draw)
	for _, path := range []string{"confirm", "redraw"} {
		w := pendingPost(t, h, memberID, "/api/rooms/"+roomID+"/"+path, fmt.Sprintf(`{"version":%d}`, v))
		if w.Code != http.StatusForbidden {
			t.Fatalf("non-host %s=%d %s", path, w.Code, w.Body.String())
		}
	}
	leave := pendingPost(t, h, hostID, "/api/leave", "")
	if leave.Code != http.StatusOK {
		t.Fatalf("host leave=%d %s", leave.Code, leave.Body.String())
	}
	redraw := pendingPost(t, h, memberID, "/api/rooms/"+roomID+"/redraw", fmt.Sprintf(`{"version":%d}`, v))
	if redraw.Code != http.StatusOK {
		t.Fatalf("successor redraw=%d %s", redraw.Code, redraw.Body.String())
	}
}

func TestPendingConcurrentConfirmAndRedrawSerializes(t *testing.T) {
	pool, ctx := pendingPool(t)
	const roomID = "78787878-7878-4878-8878-787878787878"
	const hostID = "79797979-7979-4979-8979-797979797979"
	seedPendingRoom(t, pool, ctx, roomID, hostID, 2)
	h := newTestApp(t, pool)
	v := responseVersion(t, pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/draw", ""))
	codes := make(chan int, 2)
	var wg sync.WaitGroup
	for _, path := range []string{"confirm", "redraw"} {
		wg.Add(1)
		go func(path string) {
			defer wg.Done()
			codes <- pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/"+path, fmt.Sprintf(`{"version":%d}`, v)).Code
		}(path)
	}
	wg.Wait()
	close(codes)
	ok, conflict := 0, 0
	for code := range codes {
		if code == http.StatusOK {
			ok++
		}
		if code == http.StatusConflict {
			conflict++
		}
	}
	if ok != 1 || conflict != 1 {
		t.Fatalf("ok=%d conflict=%d", ok, conflict)
	}
}

func TestPendingConfirmRejectsHardInvalidWinner(t *testing.T) {
	pool, ctx := pendingPool(t)
	const roomID = "80808080-8080-4080-8080-808080808080"
	const hostID = "81818181-8181-4181-8181-818181818181"
	seedPendingRoom(t, pool, ctx, roomID, hostID, 2)
	h := newTestApp(t, pool)
	draw := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/draw", "")
	v := responseVersion(t, draw)
	var winner string
	if err := pool.QueryRow(ctx, `select winner_restaurant_id from draws where room_id=$1 and version=$2`, roomID, v).Scan(&winner); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `update restaurants set price_level=4 where id=$1`, winner); err != nil {
		t.Fatal(err)
	}
	w := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/confirm", fmt.Sprintf(`{"version":%d}`, v))
	if w.Code != http.StatusConflict {
		t.Fatalf("confirm=%d %s", w.Code, w.Body.String())
	}
	var history int
	if err := pool.QueryRow(ctx, `select count(*) from dining_history where room_id=$1`, roomID).Scan(&history); err != nil {
		t.Fatal(err)
	}
	if history != 0 {
		t.Fatalf("history=%d want=0", history)
	}
}

func TestPendingBatchExclusionSurvivesMemberLeave(t *testing.T) {
	pool, ctx := pendingPool(t)
	const roomID = "82828282-8282-4282-8282-828282828282"
	const hostID = "83838383-8383-4383-8383-838383838383"
	const memberID = "84848484-8484-4484-8484-848484848484"
	seedPendingRoom(t, pool, ctx, roomID, hostID, 3)
	addPendingMember(t, pool, ctx, roomID, memberID)
	h := newTestApp(t, pool)
	v := responseVersion(t, pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/draw", ""))
	if w := pendingPost(t, h, hostID, "/api/rooms/"+roomID+"/redraw", fmt.Sprintf(`{"version":%d}`, v)); w.Code != http.StatusOK {
		t.Fatalf("redraw=%d %s", w.Code, w.Body.String())
	}
	if w := pendingPost(t, h, memberID, "/api/leave", ""); w.Code != http.StatusOK {
		t.Fatalf("leave=%d %s", w.Code, w.Body.String())
	}
	var excluded int
	if err := pool.QueryRow(ctx, `select count(*) from room_candidates where room_id=$1 and batch_excluded`, roomID).Scan(&excluded); err != nil {
		t.Fatal(err)
	}
	if excluded != 1 {
		t.Fatalf("batch exclusions after leave=%d want=1", excluded)
	}
}

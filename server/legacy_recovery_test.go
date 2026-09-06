package main

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestStartVotingRestoresRedactedLegacyCandidates(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const host = "28100000-0000-0000-0000-000000000001"
	const room = "28100000-0000-0000-0000-000000000010"
	const restaurant = "28100000-0000-0000-0000-000000000020"
	seedVotingRoomCandidate(t, ctx, pool, host, room, restaurant, "legacy-recovery@test.dev", "legacy-recovery")
	if _, err := pool.Exec(ctx, `with changed as (
 update rooms set status='candidates' where id=$1 returning id)
 update room_candidates set probability=null,weight_breakdown='[]' where room_id in (select id from changed)`, room); err != nil {
		t.Fatal(err)
	}
	h := newTestApp(t, pool)
	req := httptest.NewRequest("POST", "/api/rooms/"+room+"/start-voting", nil)
	req.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", host))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, req)
	if w.Code != http.StatusOK {
		t.Fatalf("start voting: %d %s", w.Code, w.Body.String())
	}
	var restored bool
	if err := pool.QueryRow(ctx, `select probability=1 and jsonb_array_length(weight_breakdown)>0
 from room_candidates where room_id=$1 and restaurant_id=$2`, room, restaurant).Scan(&restored); err != nil {
		t.Fatal(err)
	}
	if !restored {
		t.Fatal("legacy candidates were not rescored")
	}
}

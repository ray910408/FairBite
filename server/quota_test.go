package main

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func TestGoogleSearchRequestBudget(t *testing.T) {
	for _, tc := range []struct {
		terms []string
		want  int
	}{
		{nil, 2},
		{[]string{"taiwanese"}, 6},
		{[]string{"taiwanese", "taiwanese", "ramen", "unknown"}, 8},
	} {
		if got := googleSearchRequestBudget(tc.terms); got != tc.want {
			t.Fatalf("budget(%v) = %d, want %d", tc.terms, got, tc.want)
		}
	}
}

func TestGoogleSearchBudgetCoversActualFanout(t *testing.T) {
	var calls, nearby atomic.Int32
	taiwaneseQueries := map[string]bool{}
	for _, query := range CuisineSearchQueries["taiwanese"] {
		taiwaneseQueries[query] = true
	}
	upstream := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		if strings.HasSuffix(r.URL.Path, ":searchNearby") {
			if nearby.Add(1) == 1 {
				w.WriteHeader(500)
				return
			}
			w.Write([]byte(`{"places":[]}`))
			return
		}
		var body struct {
			TextQuery string `json:"textQuery"`
		}
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
			w.WriteHeader(400)
			return
		}
		if taiwaneseQueries[body.TextQuery] {
			w.Write([]byte(`{"places":[],"nextPageToken":"page-two"}`))
		} else {
			w.WriteHeader(500)
		} // exercise every ordinary query's retry
	}))
	defer upstream.Close()
	var terms []string
	for term := range CuisineSearchQueries {
		terms = append(terms, term, term)
	}
	terms = append(terms, "unknown")
	if _, err := NewGooglePlacesProvider("test", upstream.URL).SearchNearby(context.Background(), 25, 121, 800, terms); err != nil {
		t.Fatal(err)
	}
	if got, want := int(calls.Load()), googleSearchRequestBudget(terms); got != want {
		t.Fatalf("actual worst-case HTTP calls=%d, reserved=%d", got, want)
	}
}

type paidCountingProvider struct{ countingSearchProvider }

func (*paidCountingProvider) Source() string { return "google" }

func quotaTestDB(t *testing.T) (*pgxpool.Pool, string) {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; database integration test requires local Supabase")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	var uid string
	if err := pool.QueryRow(ctx, `insert into auth.users (id, email) values (gen_random_uuid(), gen_random_uuid()::text || '@quota.test') returning id`).Scan(&uid); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, err := pool.Exec(ctx, `delete from public.search_quota_leases where room_id in (select id from public.rooms where host_id=$1)`, uid)
		if err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(ctx, `delete from public.rooms where host_id=$1`, uid); err != nil {
			t.Error(err)
		}
		if _, err := pool.Exec(ctx, `delete from auth.users where id=$1`, uid); err != nil {
			t.Error(err)
		}
	})
	return pool, uid
}

func quotaTestRoom(t *testing.T, pool *pgxpool.Pool, uid string) string {
	t.Helper()
	var room string
	if err := pool.QueryRow(context.Background(), `insert into public.rooms (host_id,center_lat,center_lng) values ($1,-80,0) returning id`, uid).Scan(&room); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(context.Background(), `insert into public.room_members (room_id,user_id) values($1,$2)`, room, uid); err != nil {
		t.Fatal(err)
	}
	return room
}

func quotaHTTPRequest(h http.Handler, token, room string) *httptest.ResponseRecorder {
	r := httptest.NewRequest("POST", "/api/rooms/"+room+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

func TestSearchQuotaHTTPDurableAcrossRoomsAndFailures(t *testing.T) {
	for _, failure := range []bool{false, true} {
		name := "empty results"
		if failure {
			name = "provider failure"
		}
		t.Run(name, func(t *testing.T) {
			pool, uid := quotaTestDB(t)
			provider := &paidCountingProvider{}
			if failure {
				provider.beforeReturn = func(context.Context) error { return errors.New("upstream unavailable") }
			}
			weather := &countingWeatherProvider{}
			h := newTestAppWithWeather(t, pool, provider, weather)
			token := signHS256(t, "test-secret-test-secret-test-secret!", uid)
			for i := 0; i < 6; i++ {
				w := quotaHTTPRequest(h, token, quotaTestRoom(t, pool, uid))
				want := http.StatusUnprocessableEntity
				if failure {
					want = http.StatusBadGateway
				}
				if i == 5 {
					want = http.StatusTooManyRequests
				}
				if w.Code != want {
					t.Fatalf("request %d: status=%d want=%d body=%s", i, w.Code, want, w.Body.String())
				}
			}
			if provider.calls.Load() != 5 || weather.currentCalls.Load() != 5 {
				t.Fatalf("denied request reached providers: places=%d weather=%d", provider.calls.Load(), weather.currentCalls.Load())
			}
			var searches, paid int
			if err := pool.QueryRow(context.Background(), `select searches_day,paid_day from public.account_resource_usage where user_id=$1`, uid).Scan(&searches, &paid); err != nil {
				t.Fatal(err)
			}
			if searches != 5 || paid != 10 {
				t.Fatalf("failed/empty searches refunded: searches=%d paid=%d", searches, paid)
			}
		})
	}
}

func TestSearchQuotaHTTPAcrossRouteInstances(t *testing.T) {
	pool, uid := quotaTestDB(t)
	room := quotaTestRoom(t, pool, uid)
	release := make(chan struct{})
	defer close(release)
	provider := &paidCountingProvider{}
	provider.beforeReturn = func(ctx context.Context) error {
		select {
		case <-release:
			return nil
		case <-ctx.Done():
			return ctx.Err()
		}
	}
	weather := &countingWeatherProvider{}
	token := signHS256(t, "test-secret-test-secret-test-secret!", uid)
	responses := make(chan int, 8)
	for i := 0; i < 8; i++ {
		h := newTestAppWithWeather(t, pool, provider, weather) // independent single-flight maps
		go func() { responses <- quotaHTTPRequest(h, token, room).Code }()
	}
	for i := 0; i < 7; i++ {
		select {
		case status := <-responses:
			if status != http.StatusTooManyRequests {
				t.Fatalf("parallel instance status=%d", status)
			}
		case <-time.After(10 * time.Second):
			t.Fatal("concurrent quota admission did not finish")
		}
	}
	if provider.calls.Load() != 1 || weather.currentCalls.Load() != 1 {
		t.Fatalf("duplicate upstream calls places=%d weather=%d", provider.calls.Load(), weather.currentCalls.Load())
	}
	// Unblock and join the final request before fixture/pool cleanup.
	release <- struct{}{}
	select {
	case status := <-responses:
		if status != 422 {
			t.Fatalf("admitted request status=%d", status)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("admitted search did not finish")
	}
}

func TestSearchQuotaAtomicGlobalConcurrency(t *testing.T) {
	pool, uid := quotaTestDB(t)
	results := make(chan struct {
		lease string
		err   error
	}, 8)
	start := make(chan struct{})
	for i := 0; i < 8; i++ {
		room := quotaTestRoom(t, pool, uid)
		go func() {
			<-start
			lease, err := reserveSearchQuota(context.Background(), pool, uid, room, 2)
			results <- struct {
				lease string
				err   error
			}{lease, err}
		}()
	}
	close(start)
	accepted := 0
	for i := 0; i < 8; i++ {
		result := <-results
		if result.err == nil {
			accepted++
			defer pool.Exec(context.Background(), `select public.release_search_quota($1)`, result.lease)
		} else if !errors.Is(result.err, ErrSearchQuota) {
			t.Fatal(result.err)
		}
	}
	if accepted != 4 {
		t.Fatalf("atomic global concurrent reservations=%d want=4", accepted)
	}
}

func TestSearchQuotaHTTPGlobalBudgetBeforeProviders(t *testing.T) {
	pool, uid := quotaTestDB(t)
	var oldLimit int
	if err := pool.QueryRow(context.Background(), `select global_paid_daily_limit from public.resource_quota_limits`).Scan(&oldLimit); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(context.Background(), `update public.resource_quota_limits set global_paid_daily_limit=$1`, oldLimit); err != nil {
			t.Error(err)
		}
	})
	if _, err := pool.Exec(context.Background(), `update public.resource_quota_limits set global_paid_daily_limit=0`); err != nil {
		t.Fatal(err)
	}
	provider := &paidCountingProvider{}
	weather := &countingWeatherProvider{}
	h := newTestAppWithWeather(t, pool, provider, weather)
	token := signHS256(t, "test-secret-test-secret-test-secret!", uid)
	w := quotaHTTPRequest(h, token, quotaTestRoom(t, pool, uid))
	if w.Code != 429 || provider.calls.Load() != 0 || weather.currentCalls.Load() != 0 {
		t.Fatalf("status=%d places=%d weather=%d", w.Code, provider.calls.Load(), weather.currentCalls.Load())
	}
}

type quotaQuery struct {
	querier
	lease pgtype.Text
	err   error
	args  []any
}

func (q *quotaQuery) QueryRow(_ context.Context, _ string, args ...any) pgx.Row {
	q.args = args
	return q
}

func (q *quotaQuery) Scan(dest ...any) error {
	if q.err != nil {
		return q.err
	}
	*dest[0].(*pgtype.Text) = q.lease
	return nil
}

func TestReserveSearchQuotaFailsClosed(t *testing.T) {
	dbErr := errors.New("database unavailable")
	for _, tc := range []struct {
		name           string
		lease          pgtype.Text
		dbErr, wantErr error
	}{
		{"database error", pgtype.Text{}, dbErr, dbErr},
		{"quota denied", pgtype.Text{}, nil, ErrSearchQuota},
		{"reserved", pgtype.Text{String: "lease", Valid: true}, nil, nil},
	} {
		t.Run(tc.name, func(t *testing.T) {
			q := &quotaQuery{lease: tc.lease, err: tc.dbErr}
			lease, err := reserveSearchQuota(context.Background(), q, "user", "room", 8)
			if !errors.Is(err, tc.wantErr) {
				t.Fatalf("err=%v want=%v", err, tc.wantErr)
			}
			if lease != tc.lease.String {
				t.Fatalf("lease=%q", lease)
			}
			if len(q.args) != 3 || q.args[2] != 8 {
				t.Fatalf("args=%v", q.args)
			}
		})
	}
}

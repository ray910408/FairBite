package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Register pool cleanup before fixture cleanup so fixtures retain a live connection.
func newTestPool(t *testing.T, ctx context.Context) *pgxpool.Pool {
	t.Helper()
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; requires local Supabase")
	}
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(pool.Close)
	return pool
}

// insertTestUser 建一筆 auth.users fixture；已存在就沿用（on conflict do nothing）。
func insertTestUser(t *testing.T, ctx context.Context, pool *pgxpool.Pool, id, email string) {
	t.Helper()
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values ($1, $2) on conflict do nothing`, id, email); err != nil {
		t.Fatal(err)
	}
}

func setTestClock(t *testing.T, now func() time.Time) {
	t.Helper()
	original := clockNow
	clockNow = now
	t.Cleanup(func() { clockNow = original })
}

func postTestRequest(h http.Handler, token, path, body string) *httptest.ResponseRecorder {
	r := httptest.NewRequest(http.MethodPost, path, strings.NewReader(body))
	if token != "" {
		r.Header.Set("Authorization", "Bearer "+token)
	}
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	return w
}

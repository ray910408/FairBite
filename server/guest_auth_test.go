package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

type fakeGuestAuthStore struct {
	saveErr error
	saveOK  bool
	uid     string
	email   string
}

func (s *fakeGuestAuthStore) SaveValidation(_ context.Context, uid, email string) (bool, error) {
	s.uid, s.email = uid, email
	return s.saveOK, s.saveErr
}

func guestUpgradeRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/validate-upgrade-email", strings.NewReader(body))
	return r.WithContext(context.WithValue(r.Context(), userIDKey, "guest-1"))
}

func TestValidateUpgradeEmail(t *testing.T) {
	mx := func(context.Context, string) ([]*net.MX, error) { return []*net.MX{{Host: "mail.example."}}, nil }
	t.Run("stores canonical exact email for current anonymous user", func(t *testing.T) {
		store := &fakeGuestAuthStore{saveOK: true}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":" Guest@GMAIL.COM "}`), store, mx)
		if w.Code != http.StatusOK || store.uid != "guest-1" || store.email != "guest@gmail.com" {
			t.Fatalf("status=%d uid=%q email=%q body=%s", w.Code, store.uid, store.email, w.Body.String())
		}
	})
	t.Run("rejects identity that the atomic store finds ineligible", func(t *testing.T) {
		store := &fakeGuestAuthStore{}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusConflict || store.email != "guest@gmail.com" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("keeps MX policy on upgrades", func(t *testing.T) {
		store := &fakeGuestAuthStore{saveOK: true}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@example.com"}`), store,
			func(context.Context, string) ([]*net.MX, error) { return nil, nil })
		if w.Code != http.StatusUnprocessableEntity || store.email != "" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("does not grant on database failure", func(t *testing.T) {
		store := &fakeGuestAuthStore{saveErr: errors.New("down")}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("rejects when account changes during validation", func(t *testing.T) {
		store := &fakeGuestAuthStore{}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusConflict {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
}

func TestPostgresGuestAuthStoreEligibility(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const validatedID = "75400000-0000-4000-8000-000000000001"
	const pendingID = "75400000-0000-4000-8000-000000000002"
	const confirmedID = "75400000-0000-4000-8000-000000000003"
	const permanentID = "75400000-0000-4000-8000-000000000004"
	ids := []string{validatedID, pendingID, confirmedID, permanentID}
	if _, err := pool.Exec(ctx, `delete from auth.users where id = any($1::uuid[])`, ids); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from auth.users where id = any($1::uuid[])`, ids)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users(id,email,is_anonymous) values
		($1,null,false), ($2,null,false), ($3,'confirmed@example.org',false), ($4,'member@example.org',false)`,
		validatedID, pendingID, confirmedID, permanentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.guest_email_validations(user_id,email,phase,expires_at) values
		($1,'retry@example.org','validated',now()+interval '10 minutes'),
		($2,'pending@example.org','pending_confirmation',now()+interval '10 minutes'),
		($3,'confirmed@example.org','confirmed',now()+interval '10 minutes')`, validatedID, pendingID, confirmedID); err != nil {
		t.Fatal(err)
	}

	store := postgresGuestAuthStore{pool: pool}
	if saved, err := store.SaveValidation(ctx, validatedID, "retry@example.org"); err != nil || !saved {
		t.Fatalf("validated retry saved=%v err=%v", saved, err)
	}
	if saved, err := store.SaveValidation(ctx, pendingID, "pending@example.org"); err != nil || !saved {
		t.Fatalf("same-email pending retry saved=%v err=%v", saved, err)
	}
	var phase, email string
	if err := pool.QueryRow(ctx, `select phase,email from public.guest_email_validations where user_id=$1`, pendingID).Scan(&phase, &email); err != nil || phase != "pending_confirmation" || email != "pending@example.org" {
		t.Fatalf("same-email pending phase=%q email=%q err=%v", phase, email, err)
	}
	if saved, err := store.SaveValidation(ctx, pendingID, "corrected@example.org"); err != nil || !saved {
		t.Fatalf("corrected pending saved=%v err=%v", saved, err)
	}
	if err := pool.QueryRow(ctx, `select phase,email from public.guest_email_validations where user_id=$1`, pendingID).Scan(&phase, &email); err != nil || phase != "validated" || email != "corrected@example.org" {
		t.Fatalf("corrected pending phase=%q email=%q err=%v", phase, email, err)
	}
	for _, tc := range []struct{ name, uid string }{{"confirmed", confirmedID}, {"permanent", permanentID}} {
		t.Run(tc.name, func(t *testing.T) {
			if saved, err := store.SaveValidation(ctx, tc.uid, "other@example.org"); err != nil || saved {
				t.Fatalf("saved=%v err=%v", saved, err)
			}
		})
	}
}

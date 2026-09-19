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
	anonymous bool
	lookupErr error
	saveErr   error
	saveOK    bool
	uid       string
	email     string
}

func (s *fakeGuestAuthStore) IsAnonymous(context.Context, string) (bool, error) {
	return s.anonymous, s.lookupErr
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
		store := &fakeGuestAuthStore{anonymous: true, saveOK: true}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":" Guest@GMAIL.COM "}`), store, mx)
		if w.Code != http.StatusOK || store.uid != "guest-1" || store.email != "guest@gmail.com" {
			t.Fatalf("status=%d uid=%q email=%q body=%s", w.Code, store.uid, store.email, w.Body.String())
		}
	})
	t.Run("rejects permanent identity from current database state", func(t *testing.T) {
		store := &fakeGuestAuthStore{}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusConflict || store.email != "" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("keeps MX policy on upgrades", func(t *testing.T) {
		store := &fakeGuestAuthStore{anonymous: true, saveOK: true}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@example.com"}`), store,
			func(context.Context, string) ([]*net.MX, error) { return nil, nil })
		if w.Code != http.StatusUnprocessableEntity || store.email != "" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("does not grant on database failure", func(t *testing.T) {
		store := &fakeGuestAuthStore{anonymous: true, saveErr: errors.New("down")}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("rejects when account changes during validation", func(t *testing.T) {
		store := &fakeGuestAuthStore{anonymous: true}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusConflict {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
}

package main

import (
	"context"
	"crypto/rand"
	"crypto/rsa"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

func TestAuthRejectsOversizedSignedToken(t *testing.T) {
	secret := "test-secret-test-secret-test-secret!"
	t.Setenv("SUPABASE_JWKS_URL", "")
	t.Setenv("SUPABASE_JWT_SECRET", secret)
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": "user", "exp": time.Now().Add(time.Hour).Unix(), "data": strings.Repeat("x", 16384),
	})
	signed, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("Authorization", "Bearer "+signed)
	w := httptest.NewRecorder()
	v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("oversized JWT reached app") })).ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("oversized JWT: got %d", w.Code)
	}
}

func TestAuthConcurrencyBoundAndDownstreamRelease(t *testing.T) {
	for _, blockVerification := range []bool{true, false} {
		t.Run(fmt.Sprint(blockVerification), func(t *testing.T) {
			secret := "test-secret-test-secret-test-secret!"
			t.Setenv("SUPABASE_JWKS_URL", "")
			t.Setenv("SUPABASE_JWT_SECRET", secret)
			v, err := NewVerifier()
			if err != nil {
				t.Fatal(err)
			}
			signed := signHS256(t, secret, "user")
			release := make(chan struct{})
			entered := make(chan struct{}, 65)
			if blockVerification {
				v.keyfuncCtx = func(context.Context) jwt.Keyfunc {
					return func(*jwt.Token) (any, error) { entered <- struct{}{}; <-release; return []byte(secret), nil }
				}
			}
			h := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if !blockVerification && r.URL.Path == "/blocked" {
					entered <- struct{}{}
					<-release
				}
				w.WriteHeader(http.StatusOK)
			}))
			request := func(path string) int {
				r := httptest.NewRequest("GET", path, nil)
				r.Header.Set("Authorization", "Bearer "+signed)
				w := httptest.NewRecorder()
				h.ServeHTTP(w, r)
				return w.Code
			}
			var wg sync.WaitGroup
			for i := 0; i < 64; i++ {
				wg.Add(1)
				go func() { defer wg.Done(); request("/blocked") }()
			}
			for i := 0; i < 64; i++ {
				<-entered
			}
			result := make(chan int, 1)
			wg.Add(1)
			go func() { defer wg.Done(); result <- request("/next") }()
			select {
			case status := <-result:
				want := http.StatusOK
				if blockVerification {
					want = http.StatusServiceUnavailable
				}
				if status != want {
					t.Errorf("admission got %d want %d", status, want)
				}
			case <-time.After(250 * time.Millisecond):
				t.Error("request queued behind occupied verifier slots")
			}
			close(release)
			wg.Wait()
		})
	}
}

func TestAuthVerificationDeadline(t *testing.T) {
	secret := "test-secret-test-secret-test-secret!"
	t.Setenv("SUPABASE_JWKS_URL", "")
	t.Setenv("SUPABASE_JWT_SECRET", secret)
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	v.keyfuncCtx = func(ctx context.Context) jwt.Keyfunc {
		return func(*jwt.Token) (any, error) {
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(3 * time.Second):
				return []byte(secret), nil
			}
		}
	}
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, secret, "user"))
	w := httptest.NewRecorder()
	start := time.Now()
	v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { t.Error("timed-out verification reached app") })).ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized || time.Since(start) > 2500*time.Millisecond {
		t.Fatalf("verification not bounded: status=%d elapsed=%v", w.Code, time.Since(start))
	}
}

func TestJWKSUnknownKIDCancellationAndCachedKey(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	var requests atomic.Int32
	refreshStarted := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) > 1 {
			close(refreshStarted)
			select {
			case <-r.Context().Done():
			case <-time.After(3 * time.Second):
			}
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
			"kty": "RSA", "kid": "known", "use": "sig", "alg": "RS256",
			"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": "AQAB",
		}}})
	}))
	defer srv.Close()
	t.Setenv("SUPABASE_JWKS_URL", srv.URL)
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	h := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	token := func(kid string) string {
		tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"sub": "user", "exp": time.Now().Add(time.Hour).Unix()})
		tok.Header["kid"] = kid
		signed, err := tok.SignedString(key)
		if err != nil {
			t.Fatal(err)
		}
		return signed
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	r := httptest.NewRequest("GET", "/x", nil).WithContext(ctx)
	r.Header.Set("Authorization", "Bearer "+token("unknown"))
	done := make(chan int, 1)
	go func() { w := httptest.NewRecorder(); h.ServeHTTP(w, r); done <- w.Code }()
	select {
	case <-refreshStarted:
	case <-time.After(time.Second):
		t.Fatal("refresh did not start")
	}
	knownRequest := httptest.NewRequest("GET", "/x", nil)
	knownRequest.Header.Set("Authorization", "Bearer "+token("known"))
	knownResponse := httptest.NewRecorder()
	h.ServeHTTP(knownResponse, knownRequest)
	if knownResponse.Code != http.StatusOK {
		t.Fatalf("cached key blocked by in-flight unknown key: %d", knownResponse.Code)
	}
	cancel()
	select {
	case status := <-done:
		if status != http.StatusUnauthorized {
			t.Fatalf("unknown key: %d", status)
		}
	case <-time.After(250 * time.Millisecond):
		t.Error("canceled pre-auth request still waits for remote JWKS")
		<-done
	}
	for i := 0; i < 20; i++ {
		r := httptest.NewRequest("GET", "/x", nil)
		r.Header.Set("Authorization", "Bearer "+token(fmt.Sprintf("unknown-%d", i)))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusUnauthorized {
			t.Fatalf("unknown token: %d", w.Code)
		}
	}
	r = httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("Authorization", "Bearer "+token("known"))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || requests.Load() != 2 {
		t.Fatalf("cached key affected by flood: status=%d JWKS requests=%d", w.Code, requests.Load())
	}
}

func TestJWKSRefreshDeadlineAndRotation(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	for _, slow := range []bool{false, true} {
		t.Run(fmt.Sprint(slow), func(t *testing.T) {
			var requests atomic.Int32
			srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				kid := "initial"
				if requests.Add(1) > 1 {
					if slow {
						select {
						case <-r.Context().Done():
						case <-time.After(4 * time.Second):
						}
						return
					}
					kid = "rotated"
				}
				json.NewEncoder(w).Encode(map[string]any{"keys": []map[string]string{{
					"kty": "RSA", "kid": kid, "use": "sig", "alg": "RS256",
					"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()), "e": "AQAB",
				}}})
			}))
			defer srv.Close()
			t.Setenv("SUPABASE_JWKS_URL", srv.URL)
			v, err := NewVerifier()
			if err != nil {
				t.Fatal(err)
			}
			tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{"sub": "user", "exp": time.Now().Add(time.Hour).Unix()})
			tok.Header["kid"] = "rotated"
			signed, err := tok.SignedString(key)
			if err != nil {
				t.Fatal(err)
			}
			r := httptest.NewRequest("GET", "/x", nil)
			r.Header.Set("Authorization", "Bearer "+signed)
			w := httptest.NewRecorder()
			start := time.Now()
			v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) })).ServeHTTP(w, r)
			want := http.StatusOK
			if slow {
				want = http.StatusUnauthorized
			}
			if w.Code != want || time.Since(start) > 2500*time.Millisecond || requests.Load() != 2 {
				t.Fatalf("rotation/refresh bound: status=%d elapsed=%v requests=%d", w.Code, time.Since(start), requests.Load())
			}
		})
	}
}

func signHS256(t *testing.T, secret, sub string) string {
	t.Helper()
	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"sub": sub, "exp": time.Now().Add(time.Hour).Unix(),
	})
	s, err := tok.SignedString([]byte(secret))
	if err != nil {
		t.Fatal(err)
	}
	return s
}

func TestAuthMiddleware(t *testing.T) {
	t.Setenv("SUPABASE_JWT_SECRET", "test-secret-test-secret-test-secret!")
	t.Setenv("SUPABASE_JWKS_URL", "") // 外部環境設了就會誤走 JWKS 路徑，HS256 測試必失敗
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	h := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Write([]byte(UserID(r)))
	}))

	r1 := httptest.NewRequest("GET", "/x", nil)
	w1 := httptest.NewRecorder()
	h.ServeHTTP(w1, r1)
	if w1.Code != http.StatusUnauthorized {
		t.Fatalf("no token: want 401 got %d", w1.Code)
	}

	r2 := httptest.NewRequest("GET", "/x", nil)
	r2.Header.Set("Authorization", "Bearer not-a-jwt")
	w2 := httptest.NewRecorder()
	h.ServeHTTP(w2, r2)
	if w2.Code != http.StatusUnauthorized {
		t.Fatalf("bad token: want 401 got %d", w2.Code)
	}

	r3 := httptest.NewRequest("GET", "/x", nil)
	r3.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", "user-123"))
	w3 := httptest.NewRecorder()
	h.ServeHTTP(w3, r3)
	if w3.Code != http.StatusOK || w3.Body.String() != "user-123" {
		t.Fatalf("valid token: got %d %q", w3.Code, w3.Body.String())
	}
}

func TestAuthMiddlewareJWKS(t *testing.T) {
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	jwks := map[string]any{"keys": []map[string]string{{
		"kty": "RSA", "kid": "test-key", "use": "sig", "alg": "RS256",
		"n": base64.RawURLEncoding.EncodeToString(key.N.Bytes()),
		"e": "AQAB",
	}}}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		json.NewEncoder(w).Encode(jwks)
	}))
	defer srv.Close()

	t.Setenv("SUPABASE_JWKS_URL", srv.URL)
	t.Setenv("SUPABASE_JWT_SECRET", "") // 確認走的是 JWKS 路徑而非 secret
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	h := v.Middleware(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, UserID(r))
	}))

	tok := jwt.NewWithClaims(jwt.SigningMethodRS256, jwt.MapClaims{
		"sub": "rsa-user", "exp": time.Now().Add(time.Hour).Unix(),
	})
	tok.Header["kid"] = "test-key"
	signed, err := tok.SignedString(key)
	if err != nil {
		t.Fatal(err)
	}
	r := httptest.NewRequest("GET", "/x", nil)
	r.Header.Set("Authorization", "Bearer "+signed)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK || w.Body.String() != "rsa-user" {
		t.Fatalf("JWKS RS256: got %d %q", w.Code, w.Body.String())
	}
}

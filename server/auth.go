package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

type ctxKey string

const userIDKey ctxKey = "userID"

type Verifier struct {
	keyfuncCtx  func(context.Context) jwt.Keyfunc
	verifySlots chan struct{}
}

const (
	jwksRefreshTimeout         = 2 * time.Second
	maxJWTBytes                = 16 * 1024
	maxConcurrentVerifications = 64
)

// SUPABASE_JWKS_URL 設定時走非對稱（supabase CLI 2.x local 與 hosted 新專案皆為 ES256）；
// SUPABASE_JWT_SECRET 僅供 legacy 對稱簽章專案（2026 底棄用）
func NewVerifier() (*Verifier, error) {
	v := &Verifier{verifySlots: make(chan struct{}, maxConcurrentVerifications)}
	if url := os.Getenv("SUPABASE_JWKS_URL"); url != "" {
		// The library's burst-1 / 5-minute limiter bounds unknown-KID refreshes.
		// Bound its wait AND refresh; cached keys do not enter that slow path.
		kf, err := keyfunc.NewDefaultOverrideCtx(context.Background(), []string{url}, keyfunc.Override{
			RateLimitWaitMax: jwksRefreshTimeout,
			HTTPTimeout:      jwksRefreshTimeout,
		})
		if err != nil {
			return nil, err
		}
		v.keyfuncCtx = kf.KeyfuncCtx
		return v, nil
	}
	secret := []byte(os.Getenv("SUPABASE_JWT_SECRET"))
	if len(secret) < 32 { // 空/過短 secret = 任何人可偽造 token，直接拒絕啟動
		return nil, fmt.Errorf("SUPABASE_JWT_SECRET 未設定或過短（<32 字元），拒絕啟動")
	}
	v.keyfuncCtx = func(context.Context) jwt.Keyfunc {
		return func(t *jwt.Token) (any, error) { return secret, nil }
	}
	return v, nil
}

func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		raw := strings.TrimPrefix(auth, "Bearer ")
		if raw == "" || raw == auth {
			jsonError(w, http.StatusUnauthorized, "missing token")
			return
		}
		if len(raw) > maxJWTBytes {
			jsonError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		// No pre-auth queue or attacker-keyed state; only bound verification work.
		select {
		case v.verifySlots <- struct{}{}:
		default:
			jsonError(w, http.StatusServiceUnavailable, "authentication busy")
			return
		}
		ctx, cancel := context.WithTimeout(r.Context(), jwksRefreshTimeout)
		claims := jwt.MapClaims{}
		_, err := jwt.ParseWithClaims(raw, claims, v.keyfuncCtx(ctx),
			jwt.WithValidMethods([]string{"HS256", "RS256", "ES256"}))
		if err == nil {
			err = ctx.Err()
		}
		cancel()
		<-v.verifySlots // Slow application handlers must not consume verification slots.
		if err != nil {
			jsonError(w, http.StatusUnauthorized, "invalid token")
			return
		}
		sub, _ := claims.GetSubject()
		if sub == "" {
			jsonError(w, http.StatusUnauthorized, "no sub claim")
			return
		}
		next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userIDKey, sub)))
	})
}

func UserID(r *http.Request) string {
	s, _ := r.Context().Value(userIDKey).(string)
	return s
}

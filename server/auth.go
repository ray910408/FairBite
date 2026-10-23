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
	methods     []string // 依驗章模式收斂：JWKS 不收 HS256、secret 模式只收 HS256
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
		v.methods = []string{"ES256", "RS256"}
		return v, nil
	}
	secret := []byte(os.Getenv("SUPABASE_JWT_SECRET"))
	if len(secret) < 32 { // 空/過短 secret = 任何人可偽造 token，直接拒絕啟動
		return nil, fmt.Errorf("SUPABASE_JWT_SECRET 未設定或過短（<32 字元），拒絕啟動")
	}
	v.keyfuncCtx = func(context.Context) jwt.Keyfunc {
		return func(t *jwt.Token) (any, error) { return secret, nil }
	}
	v.methods = []string{"HS256"}
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
		// Supabase 使用者 token（含匿名登入）的 aud 一律是 authenticated；anon／service key 沒有 sub 也沒有這個 aud
		_, err := jwt.ParseWithClaims(raw, claims, v.keyfuncCtx(ctx),
			jwt.WithValidMethods(v.methods), jwt.WithAudience("authenticated"), jwt.WithExpirationRequired())
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

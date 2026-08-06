package main

import (
	"context"
	"fmt"
	"net/http"
	"os"
	"strings"

	"github.com/MicahParks/keyfunc/v3"
	"github.com/golang-jwt/jwt/v5"
)

type ctxKey string

const userIDKey ctxKey = "userID"

type Verifier struct{ keyfunc jwt.Keyfunc }

// SUPABASE_JWKS_URL 設定時走非對稱（supabase CLI 2.x local 與 hosted 新專案皆為 ES256）；
// SUPABASE_JWT_SECRET 僅供 legacy 對稱簽章專案（2026 底棄用）
func NewVerifier() (*Verifier, error) {
	if url := os.Getenv("SUPABASE_JWKS_URL"); url != "" {
		kf, err := keyfunc.NewDefaultCtx(context.Background(), []string{url})
		if err != nil {
			return nil, err
		}
		return &Verifier{keyfunc: kf.Keyfunc}, nil
	}
	secret := []byte(os.Getenv("SUPABASE_JWT_SECRET"))
	if len(secret) < 32 { // 空/過短 secret = 任何人可偽造 token，直接拒絕啟動
		return nil, fmt.Errorf("SUPABASE_JWT_SECRET 未設定或過短（<32 字元），拒絕啟動")
	}
	return &Verifier{keyfunc: func(t *jwt.Token) (any, error) { return secret, nil }}, nil
}

func (v *Verifier) Middleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		raw := strings.TrimPrefix(auth, "Bearer ")
		if raw == "" || raw == auth {
			jsonError(w, http.StatusUnauthorized, "missing token")
			return
		}
		claims := jwt.MapClaims{}
		_, err := jwt.ParseWithClaims(raw, claims, v.keyfunc,
			jwt.WithValidMethods([]string{"HS256", "RS256", "ES256"}))
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

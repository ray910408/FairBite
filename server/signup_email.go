package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"time"

	"golang.org/x/time/rate"
)

// Keep the format policy aligned with web/src/pages/AuthPage.tsx.
var signupEmailPattern = regexp.MustCompile("(?i)^[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+(?:\\.[a-z0-9!#$%&'*+/=?^_\x60{|}~-]+)*@[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*\\.[a-z]{2,63}$")

func checkSignupEmail(ctx context.Context, email string, lookupMX func(context.Context, string) ([]*net.MX, error)) string {
	email = strings.TrimSpace(email)
	local, domain, _ := strings.Cut(email, "@")
	if len(email) > 254 || len(local) > 64 || !signupEmailPattern.MatchString(email) {
		return "signup_email_invalid"
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	// Absolute DNS name prevents the OS resolver from appending local search domains.
	records, err := lookupMX(ctx, strings.ToLower(domain)+".")
	if err != nil {
		var dnsErr *net.DNSError
		if errors.As(err, &dnsErr) && dnsErr.IsNotFound {
			return "signup_email_no_mx"
		}
		return "signup_email_dns_unavailable"
	}
	if len(records) == 0 {
		return "signup_email_no_mx"
	}
	for _, record := range records {
		// Null MX explicitly declares no email service (RFC 7505).
		// Require explicit MX: deliberately do not fall back to A/AAAA.
		if record == nil || record.Host == "" || record.Host == "." {
			return "signup_email_no_mx"
		}
	}
	return ""
}

// Standard Webhooks v1: HMAC-SHA256 over id.timestamp.raw_body, with a five-minute window.
func verifySignupSignature(key, body []byte, headers http.Header, now time.Time) bool {
	id, timestamp := headers.Get("webhook-id"), headers.Get("webhook-timestamp")
	seconds, err := strconv.ParseInt(timestamp, 10, 64)
	if id == "" || err != nil || seconds < now.Add(-5*time.Minute).Unix() || seconds > now.Add(5*time.Minute).Unix() {
		return false
	}
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(id + "." + timestamp + "."))
	mac.Write(body)
	expected := mac.Sum(nil)
	for _, candidate := range strings.Fields(headers.Get("webhook-signature")) {
		// Supabase joins rotated signatures with ", "; Standard Webhooks also allows spaces.
		version, encoded, ok := strings.Cut(strings.TrimSuffix(candidate, ","), ",")
		if !ok || version != "v1" {
			continue
		}
		signature, err := base64.StdEncoding.DecodeString(encoded)
		if err == nil && hmac.Equal(signature, expected) {
			return true
		}
	}
	return false
}

func newSignupHook(secret string, lookupMX func(context.Context, string) ([]*net.MX, error)) http.Handler {
	encoded, hasPrefix := strings.CutPrefix(secret, "v1,whsec_")
	key, keyErr := base64.StdEncoding.DecodeString(encoded)
	// ponytail: per-instance global 5/s, burst 10; tune for measured signup traffic.
	limiter := rate.NewLimiter(5, 10)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !hasPrefix || keyErr != nil || len(key) < 32 {
			jsonError(w, http.StatusServiceUnavailable, "signup_hook_not_configured")
			return
		}
		// Bound slow uploads as well as body size; this route precedes user JWT authentication.
		controller := http.NewResponseController(w)
		_ = controller.SetReadDeadline(time.Now().Add(time.Second))
		defer controller.SetReadDeadline(time.Time{})
		body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, 64*1024))
		if err != nil {
			var tooLarge *http.MaxBytesError
			if errors.As(err, &tooLarge) {
				jsonError(w, http.StatusRequestEntityTooLarge, "hook_payload_too_large")
			} else {
				jsonError(w, http.StatusBadRequest, "invalid_hook_payload")
			}
			return
		}
		if !verifySignupSignature(key, body, r.Header, time.Now()) {
			jsonError(w, http.StatusUnauthorized, "invalid_hook_signature")
			return
		}
		var event struct {
			User struct {
				Email string `json:"email"`
			} `json:"user"`
		}
		if json.Unmarshal(body, &event) != nil {
			jsonError(w, http.StatusBadRequest, "invalid_hook_payload")
			return
		}
		code := "signup_email_rate_limited"
		if limiter.Allow() {
			code = checkSignupEmail(r.Context(), event.User.Email, lookupMX)
		}
		if code != "" {
			// Successful hook transport with a business rejection: Auth parses this error
			// and aborts user creation. HTTP 4xx would discard the useful message.
			jsonOK(w, map[string]any{"error": map[string]any{"http_code": 422, "message": code}})
			return
		}
		jsonOK(w, map[string]any{})
	})
}

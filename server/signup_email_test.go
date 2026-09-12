package main

import (
	"context"
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
)

func TestSignupEmailFormat(t *testing.T) {
	valid := []string{
		"user@example.com", "abc@gmail.com", "student@ttu.edu.tw", "test.user+1@gmail.com",
		"a@b.co", "USER@EXAMPLE.COM", "user123@sub.example.com", "abc-def@example.com",
		"23@d.dd", " user@example.com ", "user@example." + strings.Repeat("a", 63),
	}
	invalid := []string{
		"1@1", "23@d.d", "a@b", "abc@gmail", "abc@localhost", "abc@", "@gmail.com",
		"abc gmail.com", "abc@@gmail.com", "abc@example.", "abc@example.c", "abc@.com",
		"abc@example..com", ".abc@gmail.com", "abc.@gmail.com", "abc..def@gmail.com", "", "   ",
		"1\\@1", "person @example.com", "person@-example.com", "person@example-.com",
		"user@example.123", "user@example." + strings.Repeat("a", 64),
		strings.Repeat("a", 65) + "@gmail.com", "user@" + strings.Repeat("a", 64) + ".com",
		"user@" + strings.Repeat(strings.Repeat("a", 63)+".", 4) + "com",
	}
	for _, email := range valid {
		t.Run("valid/"+email, func(t *testing.T) {
			calls := 0
			code := checkSignupEmail(context.Background(), email, func(ctx context.Context, domain string) ([]*net.MX, error) {
				calls++
				want := strings.ToLower(strings.Split(strings.TrimSpace(email), "@")[1]) + "."
				if domain != want {
					t.Fatalf("lookup domain = %q, want absolute DNS name %q", domain, want)
				}
				deadline, ok := ctx.Deadline()
				if !ok || time.Until(deadline) > 2*time.Second {
					t.Fatal("DNS lookup must have a deadline of at most 2 seconds")
				}
				return []*net.MX{{Host: "mail.example.com.", Pref: 10}}, nil
			})
			if code != "" || calls != 1 {
				t.Fatalf("code=%q, DNS calls=%d", code, calls)
			}
		})
	}
	for _, email := range invalid {
		t.Run("invalid/"+email, func(t *testing.T) {
			code := checkSignupEmail(context.Background(), email, func(context.Context, string) ([]*net.MX, error) {
				t.Fatal("invalid format must not query DNS")
				return nil, nil
			})
			if code != "signup_email_invalid" {
				t.Fatalf("code=%q", code)
			}
		})
	}
}

func TestSignupEmailMX(t *testing.T) {
	for _, tc := range []struct {
		name string
		mx   []*net.MX
		err  error
		want string
	}{
		{"mail server", []*net.MX{{Host: "mail.example.com."}}, nil, ""},
		{"no MX", nil, nil, "signup_email_no_mx"},
		{"NXDOMAIN", nil, &net.DNSError{IsNotFound: true}, "signup_email_no_mx"},
		{"null MX", []*net.MX{{Host: ".", Pref: 0}}, nil, "signup_email_no_mx"},
		{"null plus ordinary MX", []*net.MX{{Host: "."}, {Host: "mail.example.com."}}, nil, "signup_email_no_mx"},
		{"empty host", []*net.MX{{Host: ""}}, nil, "signup_email_no_mx"},
		{"DNS timeout", nil, &net.DNSError{IsTimeout: true}, "signup_email_dns_unavailable"},
		{"SERVFAIL", nil, &net.DNSError{IsTemporary: true}, "signup_email_dns_unavailable"},
		{"partial result with error", []*net.MX{{Host: "mail.example.com."}}, errors.New("DNS failure"), "signup_email_dns_unavailable"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			code := checkSignupEmail(context.Background(), "user@example.com", func(context.Context, string) ([]*net.MX, error) {
				return tc.mx, tc.err
			})
			if code != tc.want {
				t.Fatalf("code=%q, want %q", code, tc.want)
			}
		})
	}
	t.Run("cancellation", func(t *testing.T) {
		ctx, cancel := context.WithCancel(context.Background())
		cancel()
		code := checkSignupEmail(ctx, "user@example.com", func(ctx context.Context, _ string) ([]*net.MX, error) {
			<-ctx.Done()
			return nil, ctx.Err()
		})
		if code != "signup_email_dns_unavailable" {
			t.Fatalf("code=%q", code)
		}
	})
}

const signupTestKey = "test-hook-key-32-bytes-long-123456"

func signedSignupRequest(body string, when time.Time) *http.Request {
	req := httptest.NewRequest(http.MethodPost, "/api/auth/before-user-created", strings.NewReader(body))
	timestamp := fmt.Sprint(when.Unix())
	mac := hmac.New(sha256.New, []byte(signupTestKey))
	fmt.Fprintf(mac, "msg_test.%s.%s", timestamp, body)
	req.Header.Set("webhook-id", "msg_test")
	req.Header.Set("webhook-timestamp", timestamp)
	req.Header.Set("webhook-signature", "v1,"+base64.StdEncoding.EncodeToString(mac.Sum(nil)))
	return req
}

func TestSignupHook(t *testing.T) {
	secret := "v1,whsec_" + base64.StdEncoding.EncodeToString([]byte(signupTestKey))
	for _, tc := range []struct {
		name, body, secret string
		mutate             func(*http.Request)
		wantStatus         int
		wantCode           string
		wantDNS            bool
	}{
		{"accept", "{\"user\":{\"email\":\"user@gmail.com\"}}", secret, nil, 200, "", true},
		{"MX rejection", "{\"user\":{\"email\":\"user@example.com\"}}", secret, nil, 200, "signup_email_no_mx", true},
		{"invalid format", "{\"user\":{\"email\":\"23@d.d\"}}", secret, nil, 200, "signup_email_invalid", false},
		{"invalid JSON", "{", secret, nil, 400, "", false},
		{"missing email", "{}", secret, nil, 200, "signup_email_invalid", false},
		{"unsigned", "{}", secret, func(r *http.Request) { r.Header.Del("webhook-signature") }, 401, "", false},
		{"missing ID", "{}", secret, func(r *http.Request) { r.Header.Del("webhook-id") }, 401, "", false},
		{"bad timestamp", "{}", secret, func(r *http.Request) { r.Header.Set("webhook-timestamp", "abc") }, 401, "", false},
		{"tampered signature", "{}", secret, func(r *http.Request) { r.Header.Set("webhook-signature", "v1,YmFk") }, 401, "", false},
		{"multiple signatures", "{\"user\":{\"email\":\"user@gmail.com\"}}", secret, func(r *http.Request) {
			r.Header.Set("webhook-signature", "v2,ignored v1,YmFk "+r.Header.Get("webhook-signature"))
		}, 200, "", true},
		{"Supabase comma-separated signatures", "{\"user\":{\"email\":\"user@gmail.com\"}}", secret, func(r *http.Request) {
			r.Header.Set("webhook-signature", r.Header.Get("webhook-signature")+", v1,YmFk")
		}, 200, "", true},
		{"tampered body", "{\"user\":{\"email\":\"user@gmail.com\"}}", secret, func(r *http.Request) {
			r.Body = io.NopCloser(strings.NewReader("{\"user\":{\"email\":\"attacker@gmail.com\"}}"))
		}, 401, "", false},
		{"missing secret", "{}", "", nil, 503, "", false},
		{"invalid secret", "{}", "not-base64", nil, 503, "", false},
		{"oversized body", strings.Repeat(" ", 64*1024+1), secret, nil, 413, "", false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			h := newSignupHook(tc.secret, func(_ context.Context, domain string) ([]*net.MX, error) {
				calls++
				if domain == "gmail.com." {
					return []*net.MX{{Host: "gmail-smtp-in.l.google.com."}}, nil
				}
				return nil, nil
			})
			req := signedSignupRequest(tc.body, time.Now())
			if tc.mutate != nil {
				tc.mutate(req)
			}
			w := httptest.NewRecorder()
			h.ServeHTTP(w, req)
			if w.Code != tc.wantStatus || (calls > 0) != tc.wantDNS {
				t.Fatalf("status=%d, DNS calls=%d, body=%s", w.Code, calls, w.Body.String())
			}
			if tc.wantCode != "" {
				// Check the exact Supabase envelope, including snake_case http_code.
				var envelope map[string]map[string]any
				if err := json.Unmarshal(w.Body.Bytes(), &envelope); err != nil {
					t.Fatal(err)
				}
				if envelope["error"]["message"] != tc.wantCode || envelope["error"]["http_code"] != float64(422) {
					t.Fatalf("invalid hook rejection: %s", w.Body.String())
				}
			}
		})
	}
	for _, age := range []time.Duration{-6 * time.Minute, 6 * time.Minute} {
		t.Run(fmt.Sprint(age), func(t *testing.T) {
			h := newSignupHook(secret, func(context.Context, string) ([]*net.MX, error) {
				t.Fatal("stale signature queried DNS")
				return nil, nil
			})
			w := httptest.NewRecorder()
			h.ServeHTTP(w, signedSignupRequest("{}", time.Now().Add(age)))
			if w.Code != 401 {
				t.Fatalf("status=%d", w.Code)
			}
		})
	}
}

func TestSignupSignatureStandardVector(t *testing.T) {
	// Published Standard Webhooks Go test vector, independent of our request signer.
	// https://github.com/standard-webhooks/standard-webhooks/blob/main/libraries/go/webhook_test.go
	key, err := base64.StdEncoding.DecodeString("MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw")
	if err != nil {
		t.Fatal(err)
	}
	headers := http.Header{}
	headers.Set("webhook-id", "msg_p5jXN8AQM9LWM0D4loKWxJek")
	headers.Set("webhook-timestamp", "1614265330")
	headers.Set("webhook-signature", "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=")
	if !verifySignupSignature(key, []byte("{\"test\": 2432232314}"), headers, time.Unix(1614265330, 0)) {
		t.Fatal("Standard Webhooks v1 vector rejected")
	}
}

func TestSignupHookRouteAndRateLimit(t *testing.T) {
	t.Setenv("SIGNUP_HOOK_SECRET", "")
	w := httptest.NewRecorder()
	newTestApp(t, nil).ServeHTTP(w, signedSignupRequest("{}", time.Now()))
	if w.Code != 503 {
		t.Fatalf("hook must use signature auth, not user JWT: %d", w.Code)
	}

	secret := "v1,whsec_" + base64.StdEncoding.EncodeToString([]byte(signupTestKey))
	h := newSignupHook(secret, func(context.Context, string) ([]*net.MX, error) { return nil, nil })
	limited := false
	for i := 0; i < 20; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, signedSignupRequest("{\"user\":{\"email\":\"user@example.com\"}}", time.Now()))
		if strings.Contains(w.Body.String(), "signup_email_rate_limited") {
			limited = true
		}
	}
	if !limited {
		t.Fatal("signed requests must be rate limited")
	}
}

// Opt-in: real DNS only, never creates an account. Deterministic tests above remain offline.
func TestSignupEmailLiveDNS(t *testing.T) {
	if os.Getenv("TEST_SIGNUP_DNS") != "1" {
		t.Skip("set TEST_SIGNUP_DNS=1 for live DNS")
	}
	for _, tc := range []struct{ email, want string }{
		{"probe@gmail.com", ""},
		{"probe@example.com", "signup_email_no_mx"},
		{"probe@fairbite-mx-check-nonexistent-20260912.com", "signup_email_no_mx"},
	} {
		code := checkSignupEmail(context.Background(), tc.email, net.DefaultResolver.LookupMX)
		if code != tc.want {
			t.Errorf("%s: code=%q, want %q", tc.email, code, tc.want)
		}
	}
}

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/url"
	"os"
	"regexp"
	"strings"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Opt-in live check for the local isolated stack. It never logs tokens, keys, or
// message bodies. Required: TEST_GUEST_AUTH_INTEGRATION=1, TEST_DATABASE_URL,
// TEST_SUPABASE_URL, TEST_SUPABASE_ANON_KEY, TEST_API_URL, TEST_MAILPIT_URL.
func TestGuestAuthLiveIntegration(t *testing.T) {
	if os.Getenv("TEST_GUEST_AUTH_INTEGRATION") != "1" {
		t.Skip("set TEST_GUEST_AUTH_INTEGRATION=1 for isolated Supabase/Auth verification")
	}
	requireEnv := func(name string) string {
		t.Helper()
		value := os.Getenv(name)
		if value == "" {
			t.Fatalf("missing %s", name)
		}
		return strings.TrimRight(value, "/")
	}
	dbURL := requireEnv("TEST_DATABASE_URL")
	supabaseURL := requireEnv("TEST_SUPABASE_URL")
	anonKey := requireEnv("TEST_SUPABASE_ANON_KEY")
	apiURL := requireEnv("TEST_API_URL")
	mailpitURL := requireEnv("TEST_MAILPIT_URL")

	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dbURL)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()

	stamp := time.Now().UTC().Format("20060102150405.000000000")
	email := "fairbite.integration+" + strings.ReplaceAll(stamp, ".", "") + "@gmail.com"
	correctedEmail := "fairbite.corrected+" + strings.ReplaceAll(stamp, ".", "") + "@gmail.com"
	password := "integration-" + stamp

	token, uid := anonymousSignup(t, ctx, supabaseURL, anonKey)
	defer func() {
		_, _ = pool.Exec(context.Background(), `delete from public.rooms where id in (select room_id from public.room_members where user_id=$1)`, uid)
		_, _ = pool.Exec(context.Background(), `delete from auth.users where id=$1`, uid)
		_, _ = pool.Exec(context.Background(), `delete from public.restaurants where place_id='guest-live-' || $1`, uid)
	}()

	roomID, historyID := seedGuestContinuity(t, ctx, pool, uid)
	direct := authUserUpdate(t, ctx, supabaseURL, anonKey, token, map[string]any{"email": email})
	if direct.StatusCode < 400 {
		direct.Body.Close()
		t.Fatal("direct anonymous updateUser bypass unexpectedly succeeded")
	}
	direct.Body.Close()

	validation := jsonRequest(t, ctx, http.MethodPost, apiURL+"/api/auth/validate-upgrade-email", token, "", map[string]any{"email": email})
	if validation.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(validation.Body, 1024))
		validation.Body.Close()
		t.Fatalf("validation status=%d body=%s", validation.StatusCode, body)
	}
	validation.Body.Close()

	linked := authUserUpdate(t, ctx, supabaseURL, anonKey, token, map[string]any{"email": email})
	if linked.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(linked.Body, 1024))
		linked.Body.Close()
		t.Fatalf("validated email link status=%d body=%s", linked.StatusCode, body)
	}
	linked.Body.Close()

	// Local Auth enforces the configured one-second email send interval.
	time.Sleep(1100 * time.Millisecond)
	correction := jsonRequest(t, ctx, http.MethodPost, apiURL+"/api/auth/validate-upgrade-email", token, "", map[string]any{"email": correctedEmail})
	if correction.StatusCode != http.StatusOK {
		body, _ := io.ReadAll(io.LimitReader(correction.Body, 1024))
		correction.Body.Close()
		t.Fatalf("corrected validation status=%d body=%s", correction.StatusCode, body)
	}
	correction.Body.Close()
	corrected := authUserUpdate(t, ctx, supabaseURL, anonKey, token, map[string]any{"email": correctedEmail})
	if corrected.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(corrected.Body, 1024))
		corrected.Body.Close()
		t.Fatalf("corrected email link status=%d body=%s", corrected.StatusCode, body)
	}
	corrected.Body.Close()
	email = correctedEmail

	verifyURL := waitForVerificationLink(t, ctx, mailpitURL, email)
	verifyReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, verifyURL, nil)
	verifyResp, err := (&http.Client{CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}).Do(verifyReq)
	if err != nil || verifyResp.StatusCode < 300 || verifyResp.StatusCode >= 400 {
		if verifyResp != nil {
			verifyResp.Body.Close()
		}
		t.Fatalf("email verification failed: status=%v err=%v", statusOf(verifyResp), err)
	}
	verifyResp.Body.Close()
	var confirmed bool
	if err := pool.QueryRow(ctx, `select not u.is_anonymous and u.email_confirmed_at is not null
		and g.phase='confirmed' and g.email=lower(u.email)
		from auth.users u join public.guest_email_validations g on g.user_id=u.id where u.id=$1`, uid).Scan(&confirmed); err != nil || !confirmed {
		t.Fatalf("email upgrade was not confirmed: confirmed=%v err=%v", confirmed, err)
	}

	blocked := postgrestCreateRoom(t, ctx, supabaseURL, anonKey, token)
	if blocked.StatusCode < 400 {
		blocked.Body.Close()
		t.Fatal("confirmed guest without password created a room")
	}
	blocked.Body.Close()

	passwordResp := authUserUpdate(t, ctx, supabaseURL, anonKey, token, map[string]any{"password": password})
	if passwordResp.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(passwordResp.Body, 1024))
		passwordResp.Body.Close()
		t.Fatalf("password completion status=%d body=%s", passwordResp.StatusCode, body)
	}
	passwordResp.Body.Close()

	assertGuestContinuity(t, ctx, pool, uid, roomID, historyID)
	created := postgrestCreateRoom(t, ctx, supabaseURL, anonKey, token)
	if created.StatusCode >= 300 {
		body, _ := io.ReadAll(io.LimitReader(created.Body, 1024))
		created.Body.Close()
		t.Fatalf("completed account cannot create room: status=%d body=%s", created.StatusCode, body)
	}
	created.Body.Close()
}

func anonymousSignup(t *testing.T, ctx context.Context, base, key string) (string, string) {
	t.Helper()
	resp := jsonRequest(t, ctx, http.MethodPost, base+"/auth/v1/signup", "", key,
		map[string]any{"data": map[string]string{"display_name": "整合測試訪客"}})
	defer resp.Body.Close()
	if resp.StatusCode >= 300 {
		t.Fatalf("anonymous signup status=%d", resp.StatusCode)
	}
	var body struct {
		AccessToken string `json:"access_token"`
		User        struct {
			ID string `json:"id"`
		} `json:"user"`
	}
	if json.NewDecoder(resp.Body).Decode(&body) != nil || body.AccessToken == "" || body.User.ID == "" {
		t.Fatal("anonymous signup returned no session")
	}
	return body.AccessToken, body.User.ID
}

func authUserUpdate(t *testing.T, ctx context.Context, base, key, token string, body map[string]any) *http.Response {
	t.Helper()
	return jsonRequest(t, ctx, http.MethodPut, base+"/auth/v1/user", token, key, body)
}

func postgrestCreateRoom(t *testing.T, ctx context.Context, base, key, token string) *http.Response {
	t.Helper()
	return jsonRequest(t, ctx, http.MethodPost, base+"/rest/v1/rpc/create_room", token, key,
		map[string]any{"p_lat": 25.0, "p_lng": 121.0})
}

func jsonRequest(t *testing.T, ctx context.Context, method, target, token, apiKey string, body any) *http.Response {
	t.Helper()
	payload, err := json.Marshal(body)
	if err != nil {
		t.Fatal(err)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(payload))
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if apiKey != "" {
		req.Header.Set("apikey", apiKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	return resp
}

func seedGuestContinuity(t *testing.T, ctx context.Context, pool *pgxpool.Pool, uid string) (string, string) {
	t.Helper()
	var roomID, historyID string
	err := pool.QueryRow(ctx, `
		with restaurant as (
			insert into public.restaurants(place_id,name,lat,lng,source)
			values ('guest-live-' || $1,'測試店',25,121,'mock') returning id
		), room as (
			insert into public.rooms(host_id,status,center_lat,center_lng) values ($1::uuid,'decided',25,121) returning id
		), member as (
			insert into public.room_members(room_id,user_id) select room.id,$1::uuid from room
		), history as (
			insert into public.dining_history(user_id,restaurant_id,room_id)
			select $1::uuid,restaurant.id,room.id from restaurant,room returning id
		)
		select room.id,history.id from room,history`, uid).Scan(&roomID, &historyID)
	if err != nil {
		t.Fatal(err)
	}
	return roomID, historyID
}

func assertGuestContinuity(t *testing.T, ctx context.Context, pool *pgxpool.Pool, uid, roomID, historyID string) {
	t.Helper()
	var memberships, histories int
	err := pool.QueryRow(ctx, `select
		(select count(*) from public.room_members where room_id=$1 and user_id=$2),
		(select count(*) from public.dining_history where id=$3 and user_id=$2)`, roomID, uid, historyID).Scan(&memberships, &histories)
	if err != nil || memberships != 1 || histories != 1 {
		t.Fatalf("guest continuity membership=%d history=%d err=%v", memberships, histories, err)
	}
}

func waitForVerificationLink(t *testing.T, ctx context.Context, mailpit, email string) string {
	t.Helper()
	verifyPattern := regexp.MustCompile(`https?://[^\s"'<>]+/auth/v1/verify\?[^\s"'<>]+`)
	deadline := time.Now().Add(15 * time.Second)
	for time.Now().Before(deadline) {
		query := mailpit + "/api/v1/search?query=" + url.QueryEscape("to:"+email)
		req, _ := http.NewRequestWithContext(ctx, http.MethodGet, query, nil)
		resp, err := http.DefaultClient.Do(req)
		if err == nil {
			body, _ := io.ReadAll(io.LimitReader(resp.Body, 2<<20))
			resp.Body.Close()
			var search struct {
				Messages []struct {
					ID string `json:"ID"`
				} `json:"messages"`
			}
			if json.Unmarshal(body, &search) == nil {
				for _, message := range search.Messages {
					detailReq, _ := http.NewRequestWithContext(ctx, http.MethodGet, mailpit+"/api/v1/message/"+url.PathEscape(message.ID), nil)
					detail, detailErr := http.DefaultClient.Do(detailReq)
					if detailErr != nil {
						continue
					}
					content, _ := io.ReadAll(io.LimitReader(detail.Body, 2<<20))
					detail.Body.Close()
					var messageBody struct {
						HTML string
						Text string
					}
					if json.Unmarshal(content, &messageBody) != nil {
						continue
					}
					if match := verifyPattern.FindString(messageBody.HTML + "\n" + messageBody.Text); match != "" {
						return strings.ReplaceAll(match, "&amp;", "&")
					}
				}
			}
		}
		select {
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(250 * time.Millisecond):
		}
	}
	t.Fatal("verification email/link not found in local inbox")
	return ""
}

func statusOf(resp *http.Response) any {
	if resp == nil {
		return nil
	}
	return resp.StatusCode
}

package main

import (
	"context"
	"encoding/json"
	"net"
	"net/http"
	"strings"

	"github.com/jackc/pgx/v5/pgxpool"
)

type guestAuthStore interface {
	SaveValidation(context.Context, string, string) (bool, error)
}

type postgresGuestAuthStore struct{ pool *pgxpool.Pool }

func (s postgresGuestAuthStore) SaveValidation(ctx context.Context, uid, email string) (bool, error) {
	var saved bool
	err := s.pool.QueryRow(ctx, `
		with anonymous_user as (
			select u.id from auth.users u where u.id = $1 and (
				coalesce(u.is_anonymous, false) or exists (
					select 1 from public.guest_email_validations g
					where g.user_id = u.id and g.phase in ('validated', 'pending_confirmation')
				)
			) for update
		), saved as (
			insert into public.guest_email_validations (user_id, email, phase, expires_at)
			select id, $2, 'validated', now() + interval '10 minutes' from anonymous_user
			on conflict (user_id) do update set
				email = excluded.email,
				phase = case
					when public.guest_email_validations.phase = 'pending_confirmation'
						and public.guest_email_validations.email = excluded.email
					then 'pending_confirmation' else 'validated' end,
				expires_at = case
					when public.guest_email_validations.phase = 'pending_confirmation'
						and public.guest_email_validations.email = excluded.email
					then public.guest_email_validations.expires_at else excluded.expires_at end,
				updated_at = now()
			where public.guest_email_validations.phase in ('validated', 'pending_confirmation')
			returning 1
		)
		select exists(select 1 from saved)`, uid, email).Scan(&saved)
	return saved, err
}

// handleValidateUpgradeEmail authorizes one exact anonymous-user email link.
// The auth.users trigger consumes this short-lived authorization, so calling
// Supabase updateUser directly cannot bypass the same Regex + MX policy.
func handleValidateUpgradeEmail(w http.ResponseWriter, r *http.Request, store guestAuthStore,
	lookupMX func(context.Context, string) ([]*net.MX, error)) {
	uid := UserID(r)
	var body struct {
		Email string `json:"email"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4*1024))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&body) != nil {
		jsonError(w, http.StatusBadRequest, "invalid_request")
		return
	}
	email := strings.ToLower(strings.TrimSpace(body.Email))
	if code := checkSignupEmail(r.Context(), email, lookupMX); code != "" {
		jsonError(w, http.StatusUnprocessableEntity, code)
		return
	}
	saved, err := store.SaveValidation(r.Context(), uid, email)
	if err != nil {
		jsonError(w, http.StatusServiceUnavailable, "upgrade_validation_unavailable")
		return
	}
	if !saved {
		jsonError(w, http.StatusConflict, "account_already_linked")
		return
	}
	jsonOK(w, map[string]bool{"ok": true})
}

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
	IsAnonymous(context.Context, string) (bool, error)
	SaveValidation(context.Context, string, string) (bool, error)
}

type postgresGuestAuthStore struct{ pool *pgxpool.Pool }

func (s postgresGuestAuthStore) IsAnonymous(ctx context.Context, uid string) (bool, error) {
	var anonymous bool
	err := s.pool.QueryRow(ctx, `select is_anonymous from auth.users where id = $1`, uid).Scan(&anonymous)
	return anonymous, err
}

func (s postgresGuestAuthStore) SaveValidation(ctx context.Context, uid, email string) (bool, error) {
	var saved bool
	err := s.pool.QueryRow(ctx, `
		with anonymous_user as (
			select id from auth.users where id = $1 and coalesce(is_anonymous, false) for update
		), saved as (
			insert into public.guest_email_validations (user_id, email, phase, expires_at)
			select id, $2, 'validated', now() + interval '10 minutes' from anonymous_user
			on conflict (user_id) do update set
				email = excluded.email,
				phase = public.guest_email_validations.phase,
				expires_at = case when public.guest_email_validations.phase = 'validated'
					then excluded.expires_at else public.guest_email_validations.expires_at end,
				updated_at = case when public.guest_email_validations.phase = 'validated'
					then now() else public.guest_email_validations.updated_at end
			where public.guest_email_validations.phase = 'validated'
				or (public.guest_email_validations.phase = 'pending_confirmation'
					and public.guest_email_validations.email = excluded.email)
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
	isAnonymous, err := store.IsAnonymous(r.Context(), uid)
	if err != nil {
		jsonError(w, http.StatusUnauthorized, "invalid_user")
		return
	}
	if !isAnonymous {
		jsonError(w, http.StatusConflict, "account_already_linked")
		return
	}
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

package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgconn"
	"github.com/jackc/pgx/v5/pgtype"
)

var ErrSearchQuota = errors.New("search resource quota exceeded")

// ErrGuestHostSearch：繼任房主的訪客（匿名或未設密碼的升級中帳號）不能動用付費搜尋額度
// （migration 20261022000100 的 reserve_search_quota 以專屬 SQLSTATE FB001 拒絕）。
var ErrGuestHostSearch = errors.New("guest host cannot spend search quota")

// Reserve the worst-case HTTP calls, including retries and Taiwanese pages.
// Unused reservations are not refunded: provider failures can still be billable.
// cuisines is cuisineUnion output, already deduplicated, matching SearchNearby's fan-out.
func googleSearchRequestBudget(cuisines []string) int {
	calls := 2 // nearby plus one retry
	for _, cuisine := range cuisines {
		queries := cuisineSearchQueries(cuisine)
		if len(queries) == 0 {
			continue
		}
		if cuisine == "taiwanese" {
			calls += 2 * len(queries) // two pages per query, no retries
		} else {
			calls += 2 // one query plus one retry
		}
	}
	return calls
}

func reserveSearchQuota(ctx context.Context, q querier, userID, roomID string, paidCalls int) (string, error) {
	var lease pgtype.Text
	// Query runs outside the candidate transaction: a 409/422/500 must not refund spend.
	if err := q.QueryRow(ctx, `select public.reserve_search_quota($1, $2, $3)::text`, userID, roomID, paidCalls).Scan(&lease); err != nil {
		var pgErr *pgconn.PgError
		if errors.As(err, &pgErr) && pgErr.Code == "FB001" {
			return "", ErrGuestHostSearch
		}
		return "", err
	}
	if !lease.Valid {
		return "", ErrSearchQuota
	}
	return lease.String, nil
}

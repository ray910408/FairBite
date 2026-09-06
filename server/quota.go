package main

import (
	"context"
	"errors"

	"github.com/jackc/pgx/v5/pgtype"
)

var ErrSearchQuota = errors.New("search resource quota exceeded")

// Reserve the worst-case HTTP calls, including retries and Taiwanese pages.
// Unused reservations are not refunded: provider failures can still be billable.
func googleSearchRequestBudget(cuisines []string) int {
	calls := 2 // nearby plus one retry
	seen := map[string]bool{}
	for _, cuisine := range cuisines {
		queries := CuisineSearchQueries[cuisine]
		if seen[cuisine] || len(queries) == 0 {
			continue
		}
		seen[cuisine] = true
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
		return "", err
	}
	if !lease.Valid {
		return "", ErrSearchQuota
	}
	return lease.String, nil
}

package main

import (
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type limiterStore struct {
	mu        sync.Mutex
	m         map[string]*limiterEntry
	perSec    rate.Limit
	burst     int
	nextSweep time.Time
}

type limiterEntry struct {
	limiter  *rate.Limiter
	lastSeen time.Time
}

const limiterMaxEntries = 10000

func newLimiterStore(perSec rate.Limit, burst int) *limiterStore {
	return &limiterStore{m: map[string]*limiterEntry{}, perSec: perSec, burst: burst}
}

func (s *limiterStore) allow(uid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := clockNow()
	if !now.Before(s.nextSweep) {
		s.nextSweep = now.Add(time.Minute)
		for id, entry := range s.m {
			// Reclaim only idle, fully replenished buckets: no reset-to-burst bypass.
			if now.Sub(entry.lastSeen) >= time.Minute && entry.limiter.TokensAt(now) >= float64(s.burst) {
				delete(s.m, id)
			}
		}
	}
	l, ok := s.m[uid]
	if !ok {
		if len(s.m) >= limiterMaxEntries {
			return false
		}
		l = &limiterEntry{limiter: rate.NewLimiter(s.perSec, s.burst)}
		s.m[uid] = l
	}
	l.lastSeen = now
	return l.limiter.AllowN(now, 1)
}

func rateLimit(store *limiterStore, next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if !store.allow(UserID(r)) {
			jsonError(w, http.StatusTooManyRequests, "請求太頻繁，請稍後再試")
			return
		}
		next.ServeHTTP(w, r)
	})
}

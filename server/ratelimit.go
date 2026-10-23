package main

import (
	"net/http"
	"sync"
	"time"

	"golang.org/x/time/rate"
)

type limiterStore struct {
	mu        sync.Mutex
	m         map[string]*rate.Limiter
	perSec    rate.Limit
	burst     int
	lastSweep time.Time
}

const limiterMaxEntries = 10000

func newLimiterStore(perSec rate.Limit, burst int) *limiterStore {
	return &limiterStore{m: map[string]*rate.Limiter{}, perSec: perSec, burst: burst}
}

func (s *limiterStore) allow(uid string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	now := clockNow()
	_, known := s.m[uid]
	// 平時每分鐘清一次；滿載時新身分最多每秒觸發一次提早清理。要佔住名額，攻擊者得讓上萬個
	// bucket 同時保持未補滿（perSec × 上限，約 2 萬 rps），而不是每個 uid 每分鐘打一次就夠。
	if since := now.Sub(s.lastSweep); since >= time.Minute ||
		(!known && len(s.m) >= limiterMaxEntries && since >= time.Second) {
		s.lastSweep = now
		for id, l := range s.m {
			// 補滿的 bucket 與新建的等價，回收不會送出額外 burst
			if l.TokensAt(now) >= float64(s.burst) {
				delete(s.m, id)
			}
		}
	}
	l, ok := s.m[uid]
	if !ok {
		if len(s.m) >= limiterMaxEntries {
			return false
		}
		l = rate.NewLimiter(s.perSec, s.burst)
		s.m[uid] = l
	}
	return l.AllowN(now, 1)
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

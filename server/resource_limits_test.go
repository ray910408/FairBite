package main

import (
	"context"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"
)

type weatherRoundTripper func(*http.Request) (*http.Response, error)

func (f weatherRoundTripper) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestWeatherCacheCardinalityBound(t *testing.T) {
	for _, failed := range []bool{false, true} {
		t.Run(fmt.Sprint(failed), func(t *testing.T) {
			p := NewOpenMeteoProvider("").(*openMeteoProvider)
			p.client.Transport = weatherRoundTripper(func(r *http.Request) (*http.Response, error) {
				status := http.StatusOK
				if failed {
					status = http.StatusBadGateway
				}
				return &http.Response{StatusCode: status, Body: io.NopCloser(strings.NewReader(`{"current":{"precipitation":0.8}}`)), Header: http.Header{}}, nil
			})
			at := clockNow()
			for i := 0; i < 4097; i++ {
				_, err := p.Current(context.Background(), 25, float64(i)/100, at)
				if (err != nil) != (failed || i >= 4096) {
					t.Fatalf("fetch %d: %v", i, err)
				}
			}
			if len(p.cache) > 4096 || len(p.failAt) > 4096 {
				t.Fatalf("unbounded weather state: positive=%d negative=%d", len(p.cache), len(p.failAt))
			}
		})
	}
}

func TestFullWeatherCacheDoesNotReturnUncacheableScoringData(t *testing.T) {
	p := NewOpenMeteoProvider("").(*openMeteoProvider)
	now := clockNow()
	for i := 0; i < weatherCacheMaxEntries; i++ {
		p.cache[fmt.Sprint(i)] = weatherEntry{w: Weather{RainMM: 1}, at: now}
	}
	p.client.Transport = weatherRoundTripper(func(r *http.Request) (*http.Response, error) {
		return &http.Response{StatusCode: http.StatusOK, Body: io.NopCloser(strings.NewReader(`{"current":{"precipitation":0.8}}`)), Header: http.Header{}}, nil
	})
	if w := loadWeather(context.Background(), p, 25, 121, now); w != nil {
		t.Fatalf("search got weather unavailable to subsequent votes: %+v", w)
	}
	if w := loadWeatherCached(p, 25, 121, now); w != nil {
		t.Fatalf("uncached location should remain neutral: %+v", w)
	}
	if len(p.cache) != weatherCacheMaxEntries {
		t.Fatal("existing cached weather was evicted")
	}
}

func TestLimiterStoreBoundAndRecovery(t *testing.T) {
	originalNow := clockNow
	now := clockNow()
	clockNow = func() time.Time { return now }
	t.Cleanup(func() { clockNow = originalNow })
	s := newLimiterStore(2, 1)
	for i := 0; i < 10000; i++ {
		if !s.allow(fmt.Sprint(i)) {
			t.Fatalf("premature rejection at %d", i)
		}
	}
	if s.allow("overflow") || len(s.m) > 10000 {
		t.Fatalf("new identities must fail closed at capacity: %d entries", len(s.m))
	}
	if s.allow("0") {
		t.Fatal("capacity pressure reset an existing user's limit")
	}
	now = now.Add(2 * time.Minute)
	if !s.allow("recovered") {
		t.Fatal("idle entries must be reclaimed")
	}
	if len(s.m) != 1 {
		t.Fatalf("idle limiter state retained: %d", len(s.m))
	}
}

func TestLimiterCleanupNeverResetsUnreplenishedBucket(t *testing.T) {
	s := newLimiterStore(0, 1)
	if !s.allow("original") {
		t.Fatal("first request denied")
	}
	originalNow := clockNow
	now := clockNow().Add(5 * time.Minute)
	clockNow = func() time.Time { return now }
	t.Cleanup(func() { clockNow = originalNow })
	if !s.allow("new") {
		t.Fatal("new identity denied")
	}
	if s.allow("original") {
		t.Fatal("cleanup refilled an exhausted bucket")
	}
}

func TestWeatherCleanupIsAmortized(t *testing.T) {
	originalNow := clockNow
	now := clockNow()
	clockNow = func() time.Time { return now }
	t.Cleanup(func() { clockNow = originalNow })
	p := NewOpenMeteoProvider("").(*openMeteoProvider)
	p.markFail("first", fmt.Errorf("failure"))
	p.failAt["old"] = now.Add(-2 * time.Hour)
	p.markFail("second", fmt.Errorf("failure"))
	if _, ok := p.failAt["old"]; !ok {
		t.Fatal("repeated write triggered another full sweep")
	}
	now = now.Add(time.Minute)
	p.markFail("third", fmt.Errorf("failure"))
	if _, ok := p.failAt["old"]; ok {
		t.Fatal("periodic cleanup did not reclaim expired entry")
	}
}

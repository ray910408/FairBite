package main

import (
	"context"
	"fmt"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"
)

func TestOpenMeteoParsesAndCaches(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		fmt.Fprint(w, `{"current":{"precipitation":1.5}}`)
	}))
	defer srv.Close()
	p := NewOpenMeteoProvider(srv.URL)
	w1, err := p.Current(context.Background(), 25.0478, 121.5170)
	if err != nil || w1.RainMM != 1.5 {
		t.Fatalf("got %v err %v", w1, err)
	}
	// 同 0.01 度格 → 必須命中快取，不再打 API
	w2, err := p.Current(context.Background(), 25.0481, 121.5168)
	if err != nil || w2.RainMM != 1.5 || calls != 1 {
		t.Fatalf("cache miss: w=%v err=%v calls=%d", w2, err, calls)
	}
}

func TestOpenMeteoNon200IsError(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	if _, err := NewOpenMeteoProvider(srv.URL).Current(context.Background(), 25, 121); err == nil {
		t.Fatal("500 應回傳 error（呼叫端據此降級為中性）")
	}
}

func TestCurrentCachedNeverFetches(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		fmt.Fprint(w, `{"current":{"precipitation":0.8}}`)
	}))
	defer srv.Close()
	p := NewOpenMeteoProvider(srv.URL)
	if _, ok := p.CurrentCached(25.0478, 121.5170); ok || calls != 0 {
		t.Fatalf("冷快取應 miss 且不發網路：ok=%v calls=%d", ok, calls)
	}
	if _, err := p.Current(context.Background(), 25.0478, 121.5170); err != nil {
		t.Fatal(err)
	}
	w, ok := p.CurrentCached(25.0478, 121.5170)
	if !ok || w.RainMM != 0.8 || calls != 1 {
		t.Fatalf("暖快取應 hit 且不再發網路：w=%v ok=%v calls=%d", w, ok, calls)
	}
}

// D24：serve-stale——TTL 過期後 CurrentCached 仍回舊值（投票期間因素不跳動）
func TestCurrentCachedServesStale(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"current":{"precipitation":0.8}}`)
	}))
	defer srv.Close()
	base := time.Now()
	originalNow := clockNow
	clockNow = func() time.Time { return base }
	t.Cleanup(func() { clockNow = originalNow })
	p := NewOpenMeteoProvider(srv.URL)
	if _, err := p.Current(context.Background(), 25, 121); err != nil {
		t.Fatal(err)
	}
	clockNow = func() time.Time { return base.Add(WeatherCacheTTL + time.Hour) }
	if w, ok := p.CurrentCached(25, 121); !ok || w.RainMM != 0.8 {
		t.Fatalf("TTL 過期後 CurrentCached 應 serve-stale：w=%v ok=%v", w, ok)
	}
}

// D24/OV#21：negative cache——故障後 1 分鐘內不重複打 API（不重複硬等 timeout）
func TestWeatherNegativeCache(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		w.WriteHeader(http.StatusInternalServerError)
	}))
	defer srv.Close()
	base := time.Now()
	originalNow := clockNow
	clockNow = func() time.Time { return base }
	t.Cleanup(func() { clockNow = originalNow })
	p := NewOpenMeteoProvider(srv.URL)
	if _, err := p.Current(context.Background(), 25, 121); err == nil || calls != 1 {
		t.Fatalf("首抓應失敗：err=%v calls=%d", nil, calls)
	}
	if _, err := p.Current(context.Background(), 25, 121); err == nil || calls != 1 {
		t.Fatalf("1 分鐘內不應重打 API：calls=%d", calls)
	}
	clockNow = func() time.Time { return base.Add(WeatherFailRetryTTL + time.Second) }
	if _, err := p.Current(context.Background(), 25, 121); err == nil || calls != 2 {
		t.Fatalf("退避期滿應重試：calls=%d", calls)
	}
}

func TestCanceledCurrentDoesNotPopulateNegativeCache(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		fmt.Fprint(w, `{"current":{"precipitation":0.6}}`)
	}))
	defer srv.Close()
	p := NewOpenMeteoProvider(srv.URL)

	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err := p.Current(canceled, 25, 121); err == nil || calls != 0 {
		t.Fatalf("已取消請求應在送出前失敗：err=%v calls=%d", err, calls)
	}

	w, err := p.Current(context.Background(), 25, 121)
	if err != nil || w.RainMM != 0.6 || calls != 1 {
		t.Fatalf("取消不應進 negative cache；fresh request 應打 API：w=%v err=%v calls=%d", w, err, calls)
	}
}

func TestOpenMeteoCacheExpires(t *testing.T) {
	calls := 0
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls++
		fmt.Fprint(w, `{"current":{"precipitation":1.5}}`)
	}))
	defer srv.Close()
	base := time.Now()
	originalNow := clockNow
	clockNow = func() time.Time { return base }
	t.Cleanup(func() { clockNow = originalNow })
	p := NewOpenMeteoProvider(srv.URL)
	if _, err := p.Current(context.Background(), 25, 121); err != nil || calls != 1 {
		t.Fatalf("first fetch: err=%v calls=%d", err, calls)
	}
	clockNow = func() time.Time { return base.Add(WeatherCacheTTL + time.Minute) }
	if _, err := p.Current(context.Background(), 25, 121); err != nil || calls != 2 {
		t.Fatalf("TTL 過期後應重抓：err=%v calls=%d", err, calls)
	}
}

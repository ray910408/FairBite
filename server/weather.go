package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"sync"
	"time"
)

type Weather struct {
	RainMM float64 // 目前降水量（mm）
}

type WeatherProvider interface {
	// Current：blocking fetch（快取 miss 時打 API）。低頻路徑（search/draw）用。
	Current(ctx context.Context, lat, lng float64) (Weather, error)
	// CurrentCached：純快取查詢，永不發網路。vote 熱路徑用（eng review D6）：
	// 投票的天氣新鮮度無關緊要（search 已定基準、draw 會權威重取），
	// 但 5 秒的 HTTP timeout 卡在寫票前的體感不可接受。
	CurrentCached(lat, lng float64) (Weather, bool)
}

// Open-Meteo：免費免金鑰（spec §2）。快取 15 分鐘：每次投票 rescore 都會查天氣，
// 天氣變化也用不到更細的粒度。
// ponytail: 快取 map 無淘汰；key 是 0.01 度格（約 1km），個人規模的相異房間中心有限
type openMeteoProvider struct {
	baseURL string
	client  *http.Client

	mu     sync.Mutex
	cache  map[string]weatherEntry
	failAt map[string]time.Time // negative cache：最近一次抓取失敗的時間（D24）
}

type weatherEntry struct {
	w  Weather
	at time.Time
}

func NewOpenMeteoProvider(baseURL string) WeatherProvider {
	if baseURL == "" {
		baseURL = "https://api.open-meteo.com"
	}
	return &openMeteoProvider{baseURL: baseURL,
		client: &http.Client{Timeout: 5 * time.Second},
		cache:  map[string]weatherEntry{},
		failAt: map[string]time.Time{}}
}

func weatherKey(lat, lng float64) string { return fmt.Sprintf("%.2f,%.2f", lat, lng) }

func (p *openMeteoProvider) Current(ctx context.Context, lat, lng float64) (Weather, error) {
	key := weatherKey(lat, lng)
	p.mu.Lock()
	if e, ok := p.cache[key]; ok && clockNow().Sub(e.at) < WeatherCacheTTL {
		p.mu.Unlock()
		return e.w, nil
	}
	// negative cache（D24/OV#21）：剛失敗過就不重複硬等 HTTP timeout；
	// 舊的成功值不被失敗覆蓋（CurrentCached 仍可 serve-stale）
	if t, ok := p.failAt[key]; ok && clockNow().Sub(t) < WeatherFailRetryTTL {
		p.mu.Unlock()
		return Weather{}, fmt.Errorf("open-meteo recently failed, backing off")
	}
	p.mu.Unlock()
	url := fmt.Sprintf("%s/v1/forecast?latitude=%.4f&longitude=%.4f&current=precipitation",
		p.baseURL, lat, lng)
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return Weather{}, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		return Weather{}, p.markFail(key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Weather{}, p.markFail(key, fmt.Errorf("open-meteo status %d", resp.StatusCode))
	}
	var body struct {
		Current struct {
			Precipitation float64 `json:"precipitation"`
		} `json:"current"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
		return Weather{}, p.markFail(key, err)
	}
	w := Weather{RainMM: body.Current.Precipitation}
	p.mu.Lock()
	p.cache[key] = weatherEntry{w: w, at: clockNow()}
	delete(p.failAt, key)
	p.mu.Unlock()
	return w, nil
}

func (p *openMeteoProvider) markFail(key string, err error) error {
	p.mu.Lock()
	p.failAt[key] = clockNow()
	p.mu.Unlock()
	return err
}

// CurrentCached：serve-stale（D24/OV#11）——曾抓到就用，**不看 TTL**。
// 投票期間 weather 因素持續存在、不因 TTL 過期而「有/無跳動」；
// 新鮮度由 search/draw 的 blocking Current 維護。重啟後首votes無天氣（罕見、可接受）。
func (p *openMeteoProvider) CurrentCached(lat, lng float64) (Weather, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.cache[weatherKey(lat, lng)]; ok {
		return e.w, true
	}
	return Weather{}, false
}

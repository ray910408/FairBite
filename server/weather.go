package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"sync"
	"time"
)

type Weather struct {
	RainMM float64 // 目前降水量（mm）
}

type WeatherProvider interface {
	// Current：blocking fetch（快取 miss 時打 API）。低頻路徑（search/draw）用。
	// at = 評估時刻（roomEvalTime）：與現在同一小時走 current=precipitation，
	// 未來小時走 hourly forecast 取該小時降雨（今日限定；forecast_days=2 含跨日保險）。
	Current(ctx context.Context, lat, lng float64, at time.Time) (Weather, error)
	// CurrentCached：純快取查詢，永不發網路。vote 熱路徑用（eng review D6）。
	CurrentCached(lat, lng float64, at time.Time) (Weather, bool)
}

// Open-Meteo：免費免金鑰（spec §2）。快取 15 分鐘：每次投票 rescore 都會查天氣，
// 天氣變化也用不到更細的粒度。小時桶 key 讓「座標格有限」不再能約束 map 大小，
// 因此成功寫入時惰性淘汰；serve-stale 只需涵蓋投票時長，保留 24 小時已綽綽有餘。
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

// key 含小時桶：不同用餐時刻是不同的天氣問題，serve-stale/negative cache 語意逐桶適用
func weatherKey(lat, lng float64, at time.Time) string {
	return fmt.Sprintf("%.2f,%.2f@%s", lat, lng, at.In(appLocation).Format("2006-01-02T15"))
}

func (p *openMeteoProvider) Current(ctx context.Context, lat, lng float64, at time.Time) (Weather, error) {
	key := weatherKey(lat, lng, at)
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
	hour := at.In(appLocation).Format("2006-01-02T15")
	sameHour := hour == clockNow().In(appLocation).Format("2006-01-02T15")
	reqURL := fmt.Sprintf("%s/v1/forecast?latitude=%.4f&longitude=%.4f&current=precipitation",
		p.baseURL, lat, lng)
	if !sameHour {
		reqURL = fmt.Sprintf("%s/v1/forecast?latitude=%.4f&longitude=%.4f&hourly=precipitation&forecast_days=2&timezone=%s",
			p.baseURL, lat, lng, url.QueryEscape(appLocation.String()))
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, reqURL, nil)
	if err != nil {
		return Weather{}, err
	}
	resp, err := p.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return Weather{}, err
		}
		return Weather{}, p.markFail(key, err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		return Weather{}, p.markFail(key, fmt.Errorf("open-meteo status %d", resp.StatusCode))
	}
	var w Weather
	if sameHour {
		var body struct {
			Current struct {
				Precipitation float64 `json:"precipitation"`
			} `json:"current"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			if ctx.Err() != nil {
				return Weather{}, err
			}
			return Weather{}, p.markFail(key, err)
		}
		w = Weather{RainMM: body.Current.Precipitation}
	} else {
		var body struct {
			Hourly struct {
				Time          []string  `json:"time"`
				Precipitation []float64 `json:"precipitation"`
			} `json:"hourly"`
		}
		if err := json.NewDecoder(resp.Body).Decode(&body); err != nil {
			if ctx.Err() != nil {
				return Weather{}, err
			}
			return Weather{}, p.markFail(key, err)
		}
		rain, found := 0.0, false
		for i, ts := range body.Hourly.Time {
			if ts == hour+":00" && i < len(body.Hourly.Precipitation) {
				rain, found = body.Hourly.Precipitation[i], true
				break
			}
		}
		if !found {
			return Weather{}, p.markFail(key, fmt.Errorf("open-meteo hourly 無 %s 資料", hour))
		}
		w = Weather{RainMM: rain}
	}
	now := clockNow()
	p.mu.Lock()
	p.cache[key] = weatherEntry{w: w, at: now}
	delete(p.failAt, key)
	// 小時桶會持續增加 key；每次成功寫入順手 O(n) 清理，map 規模小且不需背景 goroutine。
	for cacheKey, e := range p.cache {
		if now.Sub(e.at) > 24*time.Hour {
			delete(p.cache, cacheKey)
		}
	}
	for failedKey, failedAt := range p.failAt {
		if now.Sub(failedAt) > time.Hour {
			delete(p.failAt, failedKey)
		}
	}
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
// 新鮮度由 search/draw 的 blocking Current 維護。重啟後首 votes 無天氣（罕見、可接受）。
// 「馬上出發」的評估時刻會跟牆鐘跨整點，當下小時可退回前一桶避免投票因素跳動；
// 未來 meal_time 桶位固定，抓取失敗就維持中性，不得借用 H-1 的其他時段資料。
func (p *openMeteoProvider) CurrentCached(lat, lng float64, at time.Time) (Weather, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if e, ok := p.cache[weatherKey(lat, lng, at)]; ok {
		return e.w, true
	}
	hour := at.In(appLocation).Format("2006-01-02T15")
	if hour == clockNow().In(appLocation).Format("2006-01-02T15") {
		if e, ok := p.cache[weatherKey(lat, lng, at.Add(-time.Hour))]; ok {
			return e.w, true
		}
	}
	return Weather{}, false
}

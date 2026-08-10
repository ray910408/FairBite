package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

// Places API (New) Nearby Search。快取條款：place_id 永存、其餘欄位 30 天內刷新
// （restaurants.fetched_at 把關，見 LoadCachedRestaurants）。
// 注意：Google 無可靠清真認證訊號 → 不產 halal_certified；清真成員因 DietaryRequires
// 的正向認證設計會排除全部 Google 結果 — 誠實行為，非 bug（ADR-0001 精神）。
type googleProvider struct {
	apiKey  string
	baseURL string
	client  *http.Client
}

func NewGooglePlacesProvider(apiKey, baseURL string) PlacesProvider {
	if baseURL == "" {
		baseURL = "https://places.googleapis.com"
	}
	return &googleProvider{apiKey, baseURL, &http.Client{Timeout: 10 * time.Second}}
}

// Google type → 本專案 cuisine tags（詞彙見 CONTEXT.md；未列入者不產 tag，只影響偏好不影響排除）
var googleTypeTags = map[string][]string{
	"japanese_restaurant":   {"japanese"},
	"ramen_restaurant":      {"japanese", "ramen"},
	"sushi_restaurant":      {"japanese", "sushi"},
	"korean_restaurant":     {"korean"},
	"chinese_restaurant":    {"taiwanese"}, // ponytail: 台灣情境下最接近使用者認知的歸類
	"indian_restaurant":     {"indian", "curry"},
	"seafood_restaurant":    {"seafood"},
	"steak_house":           {"steak", "western"},
	"american_restaurant":   {"western"},
	"italian_restaurant":    {"western"},
	"french_restaurant":     {"western"},
	"hamburger_restaurant":  {"western"},
	"pizza_restaurant":      {"western"},
	"breakfast_restaurant":  {"breakfast"},
	"vegetarian_restaurant": {"vegetarian_friendly"},
	"vegan_restaurant":      {"vegetarian_friendly"},
}

var gPriceLevels = map[string]int{
	"PRICE_LEVEL_FREE": 0, "PRICE_LEVEL_INEXPENSIVE": 1, "PRICE_LEVEL_MODERATE": 2,
	"PRICE_LEVEL_EXPENSIVE": 3, "PRICE_LEVEL_VERY_EXPENSIVE": 4,
}

type gPoint struct {
	Day, Hour, Minute int
}

type gPlace struct {
	ID             string `json:"id"`
	BusinessStatus string `json:"businessStatus"`
	DisplayName    struct {
		Text string `json:"text"`
	} `json:"displayName"`
	Types      []string `json:"types"`
	PriceLevel string   `json:"priceLevel"`
	Location   struct {
		Latitude  float64 `json:"latitude"`
		Longitude float64 `json:"longitude"`
	} `json:"location"`
	FormattedAddress     string  `json:"formattedAddress"`
	Rating               float64 `json:"rating"`
	ServesVegetarianFood bool    `json:"servesVegetarianFood"`
	RegularOpeningHours  struct {
		Periods []struct {
			Open  gPoint  `json:"open"`
			Close *gPoint `json:"close"`
		} `json:"periods"`
	} `json:"regularOpeningHours"`
}

func (g *googleProvider) SearchNearby(ctx context.Context, lat, lng float64, radiusM int) ([]Restaurant, error) {
	var lastErr error
	for attempt := 0; attempt < 2; attempt++ { // spec §8：失敗重試一次
		rs, err := g.call(ctx, lat, lng, radiusM)
		if err == nil {
			return rs, nil
		}
		lastErr = err
	}
	return nil, lastErr
}

func (g *googleProvider) call(ctx context.Context, lat, lng float64, radiusM int) ([]Restaurant, error) {
	body, _ := json.Marshal(map[string]any{
		"includedTypes":  []string{"restaurant"},
		"maxResultCount": 20, // API 上限
		"languageCode":   "zh-TW",
		"locationRestriction": map[string]any{
			"circle": map[string]any{
				"center": map[string]float64{"latitude": lat, "longitude": lng},
				"radius": float64(radiusM),
			},
		},
	})
	req, err := http.NewRequestWithContext(ctx, "POST",
		g.baseURL+"/v1/places:searchNearby", bytes.NewReader(body))
	if err != nil {
		return nil, err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Goog-Api-Key", g.apiKey)
	req.Header.Set("X-Goog-FieldMask",
		"places.id,places.displayName,places.types,places.priceLevel,places.location,"+
			"places.formattedAddress,places.rating,places.businessStatus,places.regularOpeningHours,places.servesVegetarianFood")
	resp, err := g.client.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		snippet, _ := io.ReadAll(io.LimitReader(resp.Body, 512))
		return nil, fmt.Errorf("places api status %d: %s", resp.StatusCode, strings.TrimSpace(string(snippet)))
	}
	var out struct {
		Places []gPlace `json:"places"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		return nil, err
	}
	rs := make([]Restaurant, 0, len(out.Places))
	for _, p := range out.Places {
		// Absent status is common, so only explicit closure carries the tombstone signal.
		closed := p.BusinessStatus == "CLOSED_TEMPORARILY" || p.BusinessStatus == "CLOSED_PERMANENTLY"
		rs = append(rs, Restaurant{
			PlaceID:     p.ID,
			Closed:      closed,
			Name:        p.DisplayName.Text,
			CuisineTags: gTags(p),
			PriceLevel:  gPrice(p.PriceLevel),
			Lat:         p.Location.Latitude,
			Lng:         p.Location.Longitude,
			Address:     p.FormattedAddress,
			Hours:       gHours(p),
			Rating:      p.Rating,
		})
	}
	return rs, nil
}

func gTags(p gPlace) []string {
	seen := map[string]bool{}
	var tags []string
	add := func(t string) {
		if !seen[t] {
			seen[t] = true
			tags = append(tags, t)
		}
	}
	for _, gt := range p.Types {
		for _, t := range googleTypeTags[gt] {
			add(t)
		}
	}
	if p.ServesVegetarianFood {
		add("vegetarian_friendly")
	}
	return tags
}

// 未對映或未提供價位 → PriceLevelUnknown；未知價位不參與預算硬排除。
func gPrice(level string) int {
	if v, ok := gPriceLevels[level]; ok {
		return v
	}
	return PriceLevelUnknown
}

func gHours(p gPlace) OpeningHours {
	oh := OpeningHours{}
	for _, period := range p.RegularOpeningHours.Periods {
		if period.Close == nil { // 24/7：Google 以單一 open{day:0,hour:0} 無 close 表示
			for _, k := range weekdayKeys {
				oh[k] = [][2]int{{0, 1440}}
			}
			return oh
		}
		openDay, closeDay := period.Open.Day, period.Close.Day
		openMin := period.Open.Hour*60 + period.Open.Minute
		closeMin := period.Close.Hour*60 + period.Close.Minute
		delta := (closeDay - openDay + len(weekdayKeys)) % len(weekdayKeys)
		if delta == 0 {
			oh[weekdayKeys[openDay]] = append(oh[weekdayKeys[openDay]], [2]int{openMin, closeMin})
			continue
		}
		if delta == 1 && closeMin <= openMin {
			// 精簡跨夜格式須保留在 open day，供 MinutesUntilClose carry-over 邏輯使用。
			oh[weekdayKeys[openDay]] = append(oh[weekdayKeys[openDay]], [2]int{openMin, closeMin})
			continue
		}
		oh[weekdayKeys[openDay]] = append(oh[weekdayKeys[openDay]], [2]int{openMin, 1440})
		for offset := 1; offset < delta; offset++ {
			day := (openDay + offset) % len(weekdayKeys)
			oh[weekdayKeys[day]] = append(oh[weekdayKeys[day]], [2]int{0, 1440})
		}
		if closeMin != 0 {
			oh[weekdayKeys[closeDay]] = append(oh[weekdayKeys[closeDay]], [2]int{0, closeMin})
		}
	}
	return oh
}

package main

import (
	"context"
	"math"
	"time"
)

type OpeningHours map[string][][2]int

var weekdayKeys = [...]string{"sun", "mon", "tue", "wed", "thu", "fri", "sat"}

func minuteOfDay(t time.Time) int { return t.Hour()*60 + t.Minute() }

func (oh OpeningHours) IsOpenAt(t time.Time) bool {
	m := minuteOfDay(t)
	for _, span := range oh[weekdayKeys[t.Weekday()]] {
		open, close := span[0], span[1]
		if close > open && m >= open && m < close {
			return true
		}
		if close <= open && m >= open { // 跨夜段的當日部分
			return true
		}
	}
	prev := weekdayKeys[(int(t.Weekday())+6)%7]
	for _, span := range oh[prev] { // 前一日跨夜延伸到今天
		if span[1] <= span[0] && m < span[1] {
			return true
		}
	}
	return false
}

func (oh OpeningHours) MinutesUntilClose(t time.Time) int {
	m := minuteOfDay(t)
	for _, span := range oh[weekdayKeys[t.Weekday()]] {
		open, close := span[0], span[1]
		if close > open && m >= open && m < close {
			if close == 1440 {
				minutes := 1440 - m
				for offset := 1; offset <= len(weekdayKeys); offset++ {
					nextSpans := oh[weekdayKeys[(int(t.Weekday())+offset)%len(weekdayKeys)]]
					var next [2]int
					found := false
					for _, span := range nextSpans {
						if span[0] == 0 {
							next = span
							found = true
							break
						}
					}
					if !found {
						return minutes
					}
					minutes += next[1] - next[0]
					if next != [2]int{0, 1440} {
						return minutes
					}
				}
				// 七天都連續為 [0,1440]：視為不會打烊，回傳大值避免 closing-soon penalty。
				return minutes
			}
			return close - m
		}
		if close <= open && m >= open {
			return (1440 - m) + close
		}
	}
	prev := weekdayKeys[(int(t.Weekday())+6)%7]
	for _, span := range oh[prev] {
		if span[1] <= span[0] && m < span[1] {
			return span[1] - m
		}
	}
	return -1
}

type Restaurant struct {
	ID          string
	PlaceID     string
	Name        string
	CuisineTags []string
	PriceLevel  int
	Lat, Lng    float64
	Address     string
	Hours       OpeningHours
	Rating      float64
	// Closed 是 transient provider 訊號；UpsertRestaurants 不會持久化。
	Closed bool
}

type PlacesProvider interface {
	SearchNearby(ctx context.Context, lat, lng float64, radiusM int) ([]Restaurant, error)
}

func Haversine(lat1, lng1, lat2, lng2 float64) float64 {
	const r = 6371000.0
	toRad := func(d float64) float64 { return d * math.Pi / 180 }
	dLat, dLng := toRad(lat2-lat1), toRad(lng2-lng1)
	a := math.Sin(dLat/2)*math.Sin(dLat/2) +
		math.Cos(toRad(lat1))*math.Cos(toRad(lat2))*math.Sin(dLng/2)*math.Sin(dLng/2)
	return 2 * r * math.Asin(math.Sqrt(a))
}

type mockProvider struct{}

func NewMockProvider() PlacesProvider { return mockProvider{} }

func (mockProvider) SearchNearby(_ context.Context, lat, lng float64, radiusM int) ([]Restaurant, error) {
	var out []Restaurant
	for _, r := range mockRestaurants {
		if Haversine(lat, lng, r.Lat, r.Lng) <= float64(radiusM) {
			out = append(out, r)
		}
	}
	return out, nil
}

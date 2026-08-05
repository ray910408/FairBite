package main

import (
	"context"
	"testing"
	"time"
)

func at(weekday time.Weekday, hh, mm int) time.Time {
	// 2026-08-02 是週日；加 weekday 天得到該星期各日
	base := time.Date(2026, 8, 2, 0, 0, 0, 0, time.Local)
	return base.AddDate(0, 0, int(weekday)).Add(time.Duration(hh)*time.Hour + time.Duration(mm)*time.Minute)
}

func TestOpeningHours(t *testing.T) {
	oh := OpeningHours{"mon": {{660, 1350}}} // 週一 11:00–22:30
	if !oh.IsOpenAt(at(time.Monday, 12, 0)) {
		t.Error("週一中午應為營業中")
	}
	if oh.IsOpenAt(at(time.Monday, 23, 0)) {
		t.Error("週一 23:00 應為未營業")
	}
	if oh.IsOpenAt(at(time.Tuesday, 12, 0)) {
		t.Error("週二未定義應為未營業")
	}
	if got := oh.MinutesUntilClose(at(time.Monday, 22, 0)); got != 30 {
		t.Errorf("22:00 距打烊應為 30，got %d", got)
	}
}

func TestOpeningHoursOvernight(t *testing.T) {
	oh := OpeningHours{"fri": {{1020, 120}}} // 週五 17:00–翌日 02:00
	if !oh.IsOpenAt(at(time.Friday, 23, 0)) {
		t.Error("週五 23:00 應為營業中")
	}
	if !oh.IsOpenAt(at(time.Saturday, 1, 0)) {
		t.Error("週六 01:00（跨夜段）應為營業中")
	}
	if oh.IsOpenAt(at(time.Saturday, 3, 0)) {
		t.Error("週六 03:00 應為未營業")
	}
	if got := oh.MinutesUntilClose(at(time.Saturday, 1, 0)); got != 60 {
		t.Errorf("跨夜段 01:00 距打烊應為 60，got %d", got)
	}
	if got := oh.MinutesUntilClose(at(time.Friday, 23, 0)); got != 180 {
		t.Errorf("週五 23:00 距打烊應為 180（跨夜累計），got %d", got)
	}
}

func TestMockProviderRadius(t *testing.T) {
	p := NewMockProvider()
	all, err := p.SearchNearby(context.Background(), 25.0478, 121.5170, 2000)
	if err != nil || len(all) < 10 {
		t.Fatalf("2km 內應有至少 10 家，got %d err %v", len(all), err)
	}
	near, _ := p.SearchNearby(context.Background(), 25.0478, 121.5170, 300)
	if len(near) == 0 || len(near) >= len(all) {
		t.Fatalf("300m 應為非空真子集，got %d / %d", len(near), len(all))
	}
	for _, r := range near {
		if Haversine(25.0478, 121.5170, r.Lat, r.Lng) > 300 {
			t.Errorf("%s 超出半徑", r.Name)
		}
	}
}

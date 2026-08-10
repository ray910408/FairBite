package main

import (
	"testing"
	"time"
)

func TestNowInAppTZUsesTaipeiWallClockForOpeningHours(t *testing.T) {
	taipei, err := time.LoadLocation("Asia/Taipei")
	if err != nil {
		t.Fatal(err)
	}
	baseUTC := time.Date(2026, 8, 3, 10, 0, 0, 0, time.UTC) // Monday 18:00 in Taipei.
	originalLocation, originalNow := appLocation, clockNow
	appLocation = taipei
	clockNow = func() time.Time { return baseUTC }
	t.Cleanup(func() {
		appLocation = originalLocation
		clockNow = originalNow
	})

	hours := OpeningHours{"mon": {{18 * 60, 22 * 60}}}
	if hours.IsOpenAt(baseUTC) {
		t.Fatal("UTC 10:00 wall clock must be outside the 18:00-22:00 period")
	}
	appNow := nowInAppTZ()
	if appNow.Weekday() != time.Monday || appNow.Hour() != 18 || appNow.Minute() != 0 {
		t.Fatalf("want Taipei Monday 18:00, got %s", appNow.Format(time.RFC3339))
	}
	if !hours.IsOpenAt(appNow) {
		t.Fatal("Taipei 18:00 wall clock must be inside the 18:00-22:00 period")
	}
}

package main

import (
	"log"
	"os"
	"time"
)

const defaultAppTZ = "Asia/Taipei"

var (
	appLocation = mustLoadAppLocation()
	clockNow    = time.Now
)

func mustLoadAppLocation() *time.Location {
	name := os.Getenv("APP_TZ")
	if name == "" {
		name = defaultAppTZ
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		log.Fatalf("invalid APP_TZ %q: %v", name, err)
	}
	return location
}

// Opening-hours periods are restaurant-local wall-clock values. Taiwan is the
// only market for now; a future per-place utcOffsetMinutes should replace APP_TZ.
func nowInAppTZ() time.Time {
	return clockNow().In(appLocation)
}

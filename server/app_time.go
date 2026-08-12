package main

import (
	"fmt"
	"os"
	"time"

	"github.com/joho/godotenv"
)

const defaultAppTZ = "Asia/Taipei"

var (
	// 測試不會執行 main，先保留既有預設時區；正式啟動會在 dotenv 載入後覆寫。
	appLocation = mustDefaultAppLocation()
	clockNow    = time.Now
)

func mustDefaultAppLocation() *time.Location {
	location, err := time.LoadLocation(defaultAppTZ)
	if err != nil {
		panic(err)
	}
	return location
}

func loadAppLocationAfterDotenv(dotenvFiles ...string) (*time.Location, error) {
	// Load 只補齊未設定的變數，保留部署平台注入的真環境變數優先語義。
	if err := godotenv.Load(dotenvFiles...); err != nil && !os.IsNotExist(err) {
		return nil, fmt.Errorf("load dotenv: %w", err)
	}
	name := os.Getenv("APP_TZ")
	if name == "" {
		name = defaultAppTZ
	}
	location, err := time.LoadLocation(name)
	if err != nil {
		return nil, fmt.Errorf("invalid APP_TZ %q: %w", name, err)
	}
	return location, nil
}

// Opening-hours periods are restaurant-local wall-clock values. Taiwan is the
// only market for now; a future per-place utcOffsetMinutes should replace APP_TZ.
func nowInAppTZ() time.Time {
	return clockNow().In(appLocation)
}

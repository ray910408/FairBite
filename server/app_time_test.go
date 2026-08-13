package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestLoadAppLocationAfterDotenv(t *testing.T) {
	writeEnv := func(t *testing.T, value string) string {
		t.Helper()
		path := filepath.Join(t.TempDir(), ".env")
		if err := os.WriteFile(path, []byte("APP_TZ="+value+"\n"), 0o600); err != nil {
			t.Fatal(err)
		}
		return path
	}
	unsetAppTZ := func(t *testing.T) {
		t.Helper()
		old, existed := os.LookupEnv("APP_TZ")
		if err := os.Unsetenv("APP_TZ"); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() {
			if existed {
				_ = os.Setenv("APP_TZ", old)
			} else {
				_ = os.Unsetenv("APP_TZ")
			}
		})
	}

	t.Run("先載入 dotenv 再解析 APP_TZ", func(t *testing.T) {
		unsetAppTZ(t)
		location, err := loadAppLocationAfterDotenv(writeEnv(t, "Asia/Tokyo"))
		if err != nil {
			t.Fatal(err)
		}
		if location.String() != "Asia/Tokyo" {
			t.Fatalf("location = %q, want Asia/Tokyo", location)
		}
	})

	t.Run("真環境變數優先於 dotenv", func(t *testing.T) {
		t.Setenv("APP_TZ", "Asia/Taipei")
		location, err := loadAppLocationAfterDotenv(writeEnv(t, "Asia/Tokyo"))
		if err != nil {
			t.Fatal(err)
		}
		if location.String() != "Asia/Taipei" {
			t.Fatalf("location = %q, want Asia/Taipei", location)
		}
	})

	t.Run("dotenv 的無效時區必須回傳錯誤", func(t *testing.T) {
		unsetAppTZ(t)
		if _, err := loadAppLocationAfterDotenv(writeEnv(t, "Invalid/NotAZone")); err == nil {
			t.Fatal("invalid APP_TZ must fail")
		}
	})

	t.Run("真環境變數的無效時區必須回傳錯誤", func(t *testing.T) {
		t.Setenv("APP_TZ", "Invalid/NotAZone")
		if _, err := loadAppLocationAfterDotenv(writeEnv(t, "Asia/Taipei")); err == nil {
			t.Fatal("invalid environment APP_TZ must fail")
		}
	})
}

func TestRoomEvalTime(t *testing.T) {
	base := time.Date(2026, 8, 13, 14, 0, 0, 0, appLocation)
	orig := clockNow
	clockNow = func() time.Time { return base }
	defer func() { clockNow = orig }()

	if got := roomEvalTime(RoomRow{}); !got.Equal(base) {
		t.Fatalf("meal_time NULL 應回現在：%v", got)
	}
	future := base.Add(5 * time.Hour)
	if got := roomEvalTime(RoomRow{MealTime: &future}); !got.Equal(future) {
		t.Fatalf("未來的 meal_time 應原樣採用：%v", got)
	}
	past := base.Add(-2 * time.Hour)
	if got := roomEvalTime(RoomRow{MealTime: &past}); !got.Equal(base) {
		t.Fatalf("過期的 meal_time 應取 max 回現在：%v", got)
	}
	if loc := roomEvalTime(RoomRow{MealTime: &future}).Location(); loc != appLocation {
		t.Fatalf("回傳值必須在 appLocation：%v", loc)
	}
}

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

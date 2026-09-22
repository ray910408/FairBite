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

	for _, tc := range []struct {
		name, dotenv, env, want string
		wantErr                 bool
	}{
		{"dotenv 時區", "Asia/Tokyo", "", "Asia/Tokyo", false},
		{"環境變數優先", "Asia/Tokyo", "Asia/Taipei", "Asia/Taipei", false},
		{"無效 dotenv 時區", "Invalid/NotAZone", "", "", true},
		{"無效環境時區", "Asia/Taipei", "Invalid/NotAZone", "", true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			if tc.env == "" {
				unsetAppTZ(t)
			} else {
				t.Setenv("APP_TZ", tc.env)
			}
			location, err := loadAppLocationAfterDotenv(writeEnv(t, tc.dotenv))
			if (err != nil) != tc.wantErr {
				t.Fatalf("error = %v, wantErr = %v", err, tc.wantErr)
			}
			if !tc.wantErr && location.String() != tc.want {
				t.Fatalf("location = %q, want %q", location, tc.want)
			}
		})
	}
}

func TestRoomEvalTime(t *testing.T) {
	base := time.Date(2026, 8, 13, 14, 0, 0, 0, appLocation)
	setTestClock(t, func() time.Time { return base })
	future, past := base.Add(5*time.Hour), base.Add(-2*time.Hour)
	for _, tc := range []struct {
		name string
		meal *time.Time
		want time.Time
	}{
		{"未設定採用現在", nil, base},
		{"未來用餐時間", &future, future},
		{"過期採用現在", &past, base},
	} {
		t.Run(tc.name, func(t *testing.T) {
			got := roomEvalTime(RoomRow{MealTime: tc.meal})
			if !got.Equal(tc.want) || got.Location() != appLocation {
				t.Fatalf("roomEvalTime = %v (%v), want %v in %v", got, got.Location(), tc.want, appLocation)
			}
		})
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

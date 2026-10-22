package main

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
	"net/http"
	"os"
	"time"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5/pgxpool"
)

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
}

// serverErrorLog 帶 file:line：使用者只看到「資料庫錯誤」這類文案，Render log 要查得到是哪一步、為什麼。
var serverErrorLog = log.New(os.Stderr, "", log.LstdFlags|log.Lshortfile)

// serverError 記下 err 再回 500，log 位置是呼叫端那一行。只記 err，不記 request
// （token、Authorization、使用者輸入都不進 log）。
func serverError(w http.ResponseWriter, err error, msg string) {
	serverErrorLog.Output(2, fmt.Sprint(err))
	jsonError(w, http.StatusInternalServerError, msg)
}

func jsonOK(w http.ResponseWriter, v any) {
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(v)
}

func cors(next http.Handler) http.Handler {
	origin := os.Getenv("WEB_ORIGIN")
	if origin == "" {
		origin = "http://localhost:5173"
	}
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", origin)
		w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func main() {
	location, err := loadAppLocationAfterDotenv()
	if err != nil {
		log.Fatal(err)
	}
	appLocation = location

	verifier, err := NewVerifier()
	if err != nil {
		log.Fatal(err)
	}
	pool, err := pgxpool.New(context.Background(), os.Getenv("SUPABASE_DB_URL"))
	if err != nil {
		log.Fatal(err)
	}
	port := os.Getenv("PORT")
	if port == "" {
		port = "8787"
	}
	provider := NewMockProvider()
	if key := os.Getenv("GOOGLE_PLACES_API_KEY"); key != "" {
		provider = NewGooglePlacesProvider(key, "")
		log.Print("places provider: google")
	} else {
		log.Print("places provider: mock（設 GOOGLE_PLACES_API_KEY 切換真 API）")
	}
	log.Printf("listening on :%s", port)
	srv := &http.Server{
		Addr:    ":" + port,
		Handler: buildRoutes(verifier, pool, provider, NewOpenMeteoProvider(""), newLimiterStore(RateLimitPerSec, RateLimitBurst)),
		// 驗身前就能佔住連線的慢速 header／body（Slowloris）要有上限；WriteTimeout 要蓋過 search 的 45 秒 deadline
		ReadHeaderTimeout: 5 * time.Second,
		ReadTimeout:       15 * time.Second,
		WriteTimeout:      60 * time.Second,
		IdleTimeout:       60 * time.Second,
	}
	log.Fatal(srv.ListenAndServe())
}

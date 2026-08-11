package main

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"os"
	_ "time/tzdata"

	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/joho/godotenv"
)

func jsonError(w http.ResponseWriter, code int, msg string) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(code)
	json.NewEncoder(w).Encode(map[string]string{"error": msg})
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
	// 本機 .env 只補齊「還沒設定」的變數：godotenv.Load 不覆寫既有環境變數，
	// 所以部署平台注入的真環境變數一律優先，檔案不存在也只是無事發生。
	_ = godotenv.Load()

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
	log.Fatal(http.ListenAndServe(":"+port,
		buildRoutes(verifier, pool, provider, NewOpenMeteoProvider(""), newLimiterStore(RateLimitPerSec, RateLimitBurst))))
}

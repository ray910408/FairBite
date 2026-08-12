package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"sort"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/jackc/pgx/v5/pgxpool"
)

func newTestApp(t *testing.T, pool *pgxpool.Pool) http.Handler {
	return newTestAppWithProvider(t, pool, NewMockProvider())
}

func newTestAppWithProvider(t *testing.T, pool *pgxpool.Pool, places PlacesProvider) http.Handler {
	return newTestAppWithWeather(t, pool, places, nil)
}

func newTestAppWithWeather(t *testing.T, pool *pgxpool.Pool, places PlacesProvider, weather WeatherProvider) http.Handler {
	t.Setenv("SUPABASE_JWT_SECRET", "test-secret-test-secret-test-secret!")
	t.Setenv("SUPABASE_JWKS_URL", "") // 外部環境設了就會誤走 JWKS 路徑，HS256 測試必失敗
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	return buildRoutes(v, pool, places, weather, newLimiterStore(1000, 1000))
}

type failingProvider struct{}

// "mock" 維持既有語意：非 google 出身 → fallback 不過濾 mock 快取。
func (failingProvider) Source() string { return "mock" }

func (failingProvider) SearchNearby(context.Context, float64, float64, int) (PlacesSearchResult, error) {
	return PlacesSearchResult{}, fmt.Errorf("simulated outage")
}

type failingWeather struct{}

func (failingWeather) Current(context.Context, float64, float64) (Weather, error) {
	return Weather{}, fmt.Errorf("simulated weather outage")
}
func (failingWeather) CurrentCached(float64, float64) (Weather, bool) { return Weather{}, false }

type countingWeatherProvider struct {
	currentCalls atomic.Int32
	cachedCalls  atomic.Int32
	weather      Weather
}

func (p *countingWeatherProvider) Current(context.Context, float64, float64) (Weather, error) {
	p.currentCalls.Add(1)
	return p.weather, nil
}

func (p *countingWeatherProvider) CurrentCached(float64, float64) (Weather, bool) {
	p.cachedCalls.Add(1)
	return p.weather, true
}

func seedVotingRoomCandidate(t *testing.T, ctx context.Context, pool *pgxpool.Pool,
	hostID, roomID, restaurantID, email, placeID string,
) {
	t.Helper()
	if _, err := pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `delete from auth.users where id = $1`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `delete from public.restaurants where id = $1`, restaurantID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		if _, err := pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID); err != nil {
			t.Errorf("cleanup room: %v", err)
		}
		if _, err := pool.Exec(ctx, `delete from auth.users where id = $1`, hostID); err != nil {
			t.Errorf("cleanup user: %v", err)
		}
		if _, err := pool.Exec(ctx, `delete from public.restaurants where id = $1`, restaurantID); err != nil {
			t.Errorf("cleanup restaurant: %v", err)
		}
	})

	if _, err := pool.Exec(ctx, `insert into auth.users (id, email) values ($1, $2)`, hostID, email); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.rooms
		(id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'voting', 25.0478, 121.5170)`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		values ($1, $2, 500, '["japanese"]', 2000, 'walking')`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.restaurants
		(id, place_id, name, cuisine_tags, price_level, lat, lng, opening_hours, source)
		values ($1, $2, 'Weather test restaurant', '["japanese"]', 1, 25.0478, 121.5171,
			'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}', 'google')`, restaurantID, placeID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.room_candidates
		(room_id, restaurant_id, status, probability, exposure_counted)
		values ($1, $2, 'kept', 1, false)`, roomID, restaurantID); err != nil {
		t.Fatal(err)
	}
}

type fixedProvider []Restaurant

func (fixedProvider) Source() string { return "mock" }

func (p fixedProvider) SearchNearby(context.Context, float64, float64, int) (PlacesSearchResult, error) {
	return PlacesSearchResult{Restaurants: p}, nil
}

type resultProvider struct {
	result PlacesSearchResult
}

func (resultProvider) Source() string { return "google" }

func (p resultProvider) SearchNearby(context.Context, float64, float64, int) (PlacesSearchResult, error) {
	return p.result, nil
}

type conditionUpdateProvider struct {
	pool        *pgxpool.Pool
	roomID      string
	userID      string
	restaurants []Restaurant
}

func (conditionUpdateProvider) Source() string { return "mock" }

func (p conditionUpdateProvider) SearchNearby(ctx context.Context, _ float64, _ float64, _ int) (PlacesSearchResult, error) {
	if _, err := p.pool.Exec(ctx, `update room_members set budget_max = 100, max_distance_m = 300
		where room_id = $1 and user_id = $2`, p.roomID, p.userID); err != nil {
		return PlacesSearchResult{}, err
	}
	return PlacesSearchResult{Restaurants: append([]Restaurant(nil), p.restaurants...)}, nil
}

type radiusGrowthProvider struct {
	pool        *pgxpool.Pool
	roomID      string
	userID      string
	restaurants []Restaurant
}

func (radiusGrowthProvider) Source() string { return "mock" }

func (p radiusGrowthProvider) SearchNearby(ctx context.Context, _ float64, _ float64, _ int) (PlacesSearchResult, error) {
	if _, err := p.pool.Exec(ctx, `update room_members set max_distance_m = 2000
		where room_id = $1 and user_id = $2`, p.roomID, p.userID); err != nil {
		return PlacesSearchResult{}, err
	}
	return PlacesSearchResult{Restaurants: append([]Restaurant(nil), p.restaurants...)}, nil
}

type blockingProvider struct {
	calls        atomic.Int32
	firstStarted chan struct{}
	releaseFirst chan struct{}
	restaurants  []Restaurant
}

func (*blockingProvider) Source() string { return "mock" }

func (p *blockingProvider) SearchNearby(context.Context, float64, float64, int) (PlacesSearchResult, error) {
	if p.calls.Add(1) == 1 {
		close(p.firstStarted)
		<-p.releaseFirst
	}
	return PlacesSearchResult{Restaurants: append([]Restaurant(nil), p.restaurants...)}, nil
}

func TestSearchRequiresAuth(t *testing.T) {
	h := newTestApp(t, nil)
	r := httptest.NewRequest("POST", "/api/rooms/00000000-0000-0000-0000-000000000001/search", nil)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusUnauthorized {
		t.Fatalf("want 401 got %d", w.Code)
	}
}

// 搜尋半徑取全員 max_distance_m 的平均，不是最小值：取最小值等於讓設得最緊的那一位
// 獨自決定全房的搜尋圈，其他人的設定完全不算數。整數除法的截斷是刻意行為，用 .33/.67
// 兩種餘數釘住——哪天有人改成四捨五入，.67 那條就會紅。
func TestAverageMemberRadius(t *testing.T) {
	membersWithRadii := func(radii []int) []Member {
		members := make([]Member, len(radii))
		for i, r := range radii {
			members[i] = Member{MaxDistanceM: r}
		}
		return members
	}
	for _, tc := range []struct {
		name  string
		radii []int
		want  int
	}{
		{"單人：平均就是他自己", []int{1500}, 1500},
		{"三人整除", []int{300, 800, 1000}, 700},
		{"取平均而非最小值（最小值會是 300）", []int{300, 2000}, 1150},
		{"餘數 .33 截斷", []int{1000, 1000, 1001}, 1000},
		{"餘數 .67 也截斷，不進位", []int{1000, 1000, 1002}, 1000},
	} {
		if got := averageMemberRadius(membersWithRadii(tc.radii)); got != tc.want {
			t.Errorf("%s：averageMemberRadius(%v) = %d，want %d", tc.name, tc.radii, got, tc.want)
		}
	}
}

func TestSearchReloadsMemberConditionsAfterProviderCall(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID     = "51515151-5151-5151-5151-515151515151"
		roomID     = "52525252-5252-5252-5252-525252525252"
		placeID    = "member-condition-race"
		farPlaceID = "member-distance-race-far"
	)
	if _, err = pool.Exec(ctx, `insert into auth.users (id, email)
		values ($1, 'member-race@test.dev') on conflict do nothing`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.rooms
		(id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 25.0478, 121.5170)
		on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, dietary, max_distance_m, transport)
		values ($1, $2, 500, '[]', '[]', 2000, 'walking')
		on conflict (room_id, user_id) do update
		set budget_max = 500, dietary = '[]', max_distance_m = 2000`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
		pool.Exec(ctx, `delete from public.restaurants where place_id in ($1, $2)`, placeID, farPlaceID)
	})

	const farName = "超出更新後距離"
	farLat, farLng := 25.0568, 121.5170
	if distance := Haversine(25.0478, 121.5170, farLat, farLng); distance <= 300 || distance > 2000 {
		t.Fatalf("far restaurant distance %.1fm must be inside old 2000m and outside new 300m radius", distance)
	}
	provider := conditionUpdateProvider{pool: pool, roomID: roomID, userID: hostID, restaurants: []Restaurant{
		{
			PlaceID: placeID, Name: "超出更新後預算", PriceLevel: 2,
			Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440}),
		},
		{
			PlaceID: farPlaceID, Name: farName, PriceLevel: 2,
			Lat: farLat, Lng: farLng, Hours: daily([2]int{0, 1440}),
		},
	}}
	h := newTestAppWithProvider(t, pool, provider)
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", hostID))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	var body struct {
		Error      string         `json:"error"`
		ExcludedBy map[string]int `json:"excluded_by"`
		Kept       []struct {
			Name string `json:"name"`
		} `json:"kept"`
		Excluded []struct {
			Name string `json:"name"`
		} `json:"excluded"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil ||
		w.Code != http.StatusUnprocessableEntity || body.Error != "no_candidates" || body.ExcludedBy["budget"] != 1 {
		t.Fatalf("搜尋必須套用 provider call 期間更新的預算與距離：status %d body %s", w.Code, w.Body.String())
	}
	for _, candidate := range append(body.Kept, body.Excluded...) {
		if candidate.Name == farName {
			t.Fatalf("超出更新後 frozen radius 的餐廳不可出現在 kept/excluded：%s", w.Body.String())
		}
	}
}

func TestSearchBouncesWhenRadiusGrowsDuringProviderCall(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID  = "61616161-6161-6161-6161-616161616161"
		roomID  = "62626262-6262-6262-6262-626262626262"
		placeID = "radius-growth-race"
		message = "成員條件已於搜尋期間變更，請再按一次開始搜尋"
	)
	if _, err = pool.Exec(ctx, `insert into auth.users (id, email)
		values ($1, 'radius-growth@test.dev') on conflict do nothing`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.rooms
		(id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 25.0478, 121.5170)
		on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, dietary, max_distance_m, transport)
		values ($1, $2, 500, '[]', '[]', 300, 'walking')
		on conflict (room_id, user_id) do update set max_distance_m = 300`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
		pool.Exec(ctx, `delete from public.restaurants where place_id = $1`, placeID)
	})

	provider := radiusGrowthProvider{pool: pool, roomID: roomID, userID: hostID, restaurants: []Restaurant{{
		PlaceID: placeID, Name: "搜尋半徑擴大測試餐廳", PriceLevel: 1,
		Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440}),
	}}}
	h := newTestAppWithProvider(t, pool, provider)
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", hostID))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	var body struct {
		Error string `json:"error"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatal(err)
	}
	var status string
	if err := pool.QueryRow(ctx, `select status from public.rooms where id = $1`, roomID).Scan(&status); err != nil {
		t.Fatal(err)
	}
	if w.Code != http.StatusConflict || body.Error != message || status != "lobby" {
		t.Fatalf("搜尋半徑變大時應回 409 並 rollback 回 lobby：status %d body %s room.status %q", w.Code, w.Body.String(), status)
	}
}

func TestSearchSingleFlightPerRoom(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID  = "53535353-5353-5353-5353-535353535353"
		roomID  = "54545454-5454-5454-5454-545454545454"
		placeID = "single-flight-search"
	)
	if _, err = pool.Exec(ctx, `insert into auth.users (id, email)
		values ($1, 'single-flight@test.dev') on conflict do nothing`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.rooms
		(id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 25.0478, 121.5170)
		on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, dietary, max_distance_m, transport)
		values ($1, $2, 500, '[]', '[]', 2000, 'walking')
		on conflict (room_id, user_id) do update set budget_max = 500, dietary = '[]'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
		pool.Exec(ctx, `delete from public.restaurants where place_id = $1`, placeID)
	})

	provider := &blockingProvider{
		firstStarted: make(chan struct{}),
		releaseFirst: make(chan struct{}),
		restaurants: []Restaurant{{
			PlaceID: placeID, Name: "單航班餐廳", PriceLevel: 1,
			Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440}),
		}},
	}
	releaseFirst := func() {
		select {
		case <-provider.releaseFirst:
		default:
			close(provider.releaseFirst)
		}
	}
	defer releaseFirst()
	h := newTestAppWithProvider(t, pool, provider)
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	responses := make(chan *httptest.ResponseRecorder, 2)
	do := func() {
		r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		responses <- w
	}

	go do()
	select {
	case <-provider.firstStarted:
	case <-time.After(5 * time.Second):
		t.Fatal("第一個搜尋未進入 provider")
	}
	go do()
	var firstResponse *httptest.ResponseRecorder
	select {
	case firstResponse = <-responses:
	case <-time.After(5 * time.Second):
		t.Fatal("第二個搜尋未在第一個 provider call 阻塞期間回應")
	}
	releaseFirst()
	var secondResponse *httptest.ResponseRecorder
	select {
	case secondResponse = <-responses:
	case <-time.After(5 * time.Second):
		t.Fatal("第一個搜尋未在 provider 釋放後完成")
	}

	codes := []int{firstResponse.Code, secondResponse.Code}
	sort.Ints(codes)
	if codes[0] != http.StatusOK || codes[1] != http.StatusConflict {
		t.Fatalf("同房並發搜尋應一個 200、一個 409，got %v; bodies: %s | %s",
			codes, firstResponse.Body.String(), secondResponse.Body.String())
	}
	for _, response := range []*httptest.ResponseRecorder{firstResponse, secondResponse} {
		if response.Code == http.StatusConflict && !strings.Contains(response.Body.String(), "房間狀態已變更") {
			t.Fatalf("並發衝突應沿用房間狀態訊息，body %s", response.Body.String())
		}
	}
	if calls := provider.calls.Load(); calls != 1 {
		t.Fatalf("同房並發搜尋只能呼叫 provider 一次，got %d", calls)
	}
}

func TestSearchAndDrawHappyPathExposureBaseline(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// 先註冊 = 後執行（Cleanup 為 LIFO）：確保下方刪 room 的 cleanup 在 pool 關閉前跑完，
	// 否則 delete 打在已關閉的 pool 上被靜默丟棄，殘留的 draws 列會讓下次執行的 draw 直接 409
	t.Cleanup(func() { pool.Close() })

	hostID := "11111111-1111-1111-1111-111111111111"
	roomID := "25252525-2525-2525-2525-252525252525"
	_, err = pool.Exec(ctx, `
		insert into auth.users (id, email) values ($1, 'host@test.dev') on conflict do nothing;
		`, hostID)
	if err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		 values ($1, $2, 500, '["japanese"]', 2000, 'walking') on conflict do nothing`,
		roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.dining_history where room_id = $1`, roomID)
		pool.Exec(ctx, `delete from public.dining_history where user_id = $1 and room_id is null`, hostID)
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})

	h := newTestApp(t, pool)
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	do := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	w1 := do(fmt.Sprintf("/api/rooms/%s/search", roomID))
	if w1.Code != http.StatusOK {
		t.Fatalf("search: want 200 got %d body %s", w1.Code, w1.Body.String())
	}
	var sr struct {
		Kept []struct {
			RestaurantID string       `json:"restaurant_id"`
			Probability  float64      `json:"probability"`
			Trace        []TraceEntry `json:"trace"`
		} `json:"kept"`
	}
	if err := json.Unmarshal(w1.Body.Bytes(), &sr); err != nil || len(sr.Kept) < 2 {
		t.Fatalf("baseline 行為測試至少需要 2 家 kept：%v %s", err, w1.Body.String())
	}
	oldID, newID := sr.Kept[0].RestaurantID, sr.Kept[1].RestaurantID
	// 在本房 search 寫入的 +1 之外，替 oldID 再加一次既有曝光；其餘候選仍只有本房的 +1。
	if _, err := pool.Exec(ctx, `update public.exposure_stats
		set recommended_count = recommended_count + 1
		where user_id = $1 and restaurant_id = $2`, hostID, oldID); err != nil {
		t.Fatal(err)
	}

	if w := do(fmt.Sprintf("/api/rooms/%s/search", roomID)); w.Code != http.StatusConflict {
		t.Fatalf("重複 search: want 409 got %d", w.Code)
	}
	if w := do("/api/rooms/" + roomID + "/start-voting"); w.Code != http.StatusOK {
		t.Fatalf("start-voting: want 200 got %d body %s", w.Code, w.Body.String())
	}
	vote := func(kind, op, restaurantID string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"restaurant_id":%q,"kind":%q,"op":%q}`, restaurantID, kind, op)
		req := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	// 第一次 rescore 將 search-kept 的新店暫時排除，迫使 room_candidates.status 改寫為 excluded。
	if w := vote("veto", "cast", newID); w.Code != http.StatusOK {
		t.Fatalf("first vote: want 200 got %d body %s", w.Code, w.Body.String())
	}
	// 第二次 rescore 收回否決、重新保留新店；baseline 必須仍記得它在 search 時確實計入曝光。
	voteW := vote("veto", "retract", newID)
	if voteW.Code != http.StatusOK {
		t.Fatalf("second vote: want 200 got %d body %s", voteW.Code, voteW.Body.String())
	}
	var vr struct {
		Kept []struct {
			RestaurantID string       `json:"restaurant_id"`
			Trace        []TraceEntry `json:"trace"`
		} `json:"kept"`
	}
	if err := json.Unmarshal(voteW.Body.Bytes(), &vr); err != nil {
		t.Fatalf("vote 回應無法解析：%v %s", err, voteW.Body.String())
	}
	var newStoreTrace TraceEntry
	foundNewStoreTrace := false
	for _, candidate := range vr.Kept {
		if candidate.RestaurantID != newID {
			continue
		}
		for _, entry := range candidate.Trace {
			if entry.Factor == "exposure" {
				newStoreTrace, foundNewStoreTrace = entry, true
			}
		}
	}
	if !foundNewStoreTrace || newStoreTrace.Mult != 1.1 || !strings.Contains(newStoreTrace.Reason, "新出現") {
		t.Fatalf("vote 應扣除本房 search +1 並保留新店加成，got %+v found=%v", newStoreTrace, foundNewStoreTrace)
	}

	w2 := do(fmt.Sprintf("/api/rooms/%s/draw", roomID))
	if w2.Code != http.StatusOK {
		t.Fatalf("draw: want 200 got %d body %s", w2.Code, w2.Body.String())
	}
	var dr struct {
		Winner string `json:"winner_restaurant_id"`
		Seed   string `json:"seed"`
	}
	if err := json.Unmarshal(w2.Body.Bytes(), &dr); err != nil || dr.Winner == "" || dr.Seed == "" {
		t.Fatalf("draw 回應不完整：%s", w2.Body.String())
	}
	if w := do(fmt.Sprintf("/api/rooms/%s/draw", roomID)); w.Code != http.StatusConflict {
		t.Fatalf("重複 draw: want 409 got %d", w.Code)
	}
}

func TestVotePreservesExcludedAtSearchExposureBaseline(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID   = "14141414-1414-4141-8141-141414141414"
		roomID   = "15151515-1515-4151-8151-151515151515"
		targetID = "16161616-1616-4161-8161-161616161616"
		anchorID = "17171717-1717-4171-8171-171717171717"
	)
	if _, err := pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `delete from auth.users where id = $1`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `delete from public.restaurants where id in ($1, $2)`, targetID, anchorID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into auth.users (id, email)
		values ($1, 'baseline-r2@test.dev')`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.rooms
		(id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'voting', 25.0478, 121.5170)`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		values ($1, $2, 500, '["japanese"]', 2000, 'walking')`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.restaurants
		(id, place_id, name, cuisine_tags, price_level, lat, lng, opening_hours, source)
		values
			($1, 'baseline-r2-target', '搜尋時排除餐廳', '["japanese"]', 1, 25.0478, 121.5171,
			 '{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}', 'google'),
			($2, 'baseline-r2-anchor', '歷史餐廳', '["japanese"]', 1, 25.0478, 121.5172,
			 '{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}', 'google')`, targetID, anchorID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.room_candidates
		(room_id, restaurant_id, status, probability, exclusion_reason, exposure_counted)
		values
			($1, $2, 'excluded', null, '搜尋時尚未符合條件', false),
			($1, $3, 'kept', 1, null, true)`, roomID, targetID, anchorID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.exposure_stats
		(user_id, restaurant_id, recommended_count)
		values ($1, $2, 1), ($1, $3, 3)`, hostID, targetID, anchorID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
		pool.Exec(ctx, `delete from auth.users where id = $1`, hostID)
		pool.Exec(ctx, `delete from public.restaurants where id in ($1, $2)`, targetID, anchorID)
	})

	h := newTestApp(t, pool)
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	vote := func(op string) *httptest.ResponseRecorder {
		body := fmt.Sprintf(`{"restaurant_id":%q,"kind":"up","op":%q}`, targetID, op)
		req := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/vote", strings.NewReader(body))
		req.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, req)
		return w
	}
	// 第一次 rescore 讓原本 excluded 的候選變 kept；第二次必須仍保留 exposure_counted=false。
	if w := vote("cast"); w.Code != http.StatusOK {
		t.Fatalf("first vote: want 200 got %d body %s", w.Code, w.Body.String())
	}
	second := vote("retract")
	if second.Code != http.StatusOK {
		t.Fatalf("second vote: want 200 got %d body %s", second.Code, second.Body.String())
	}
	var response struct {
		Kept []struct {
			RestaurantID string       `json:"restaurant_id"`
			Trace        []TraceEntry `json:"trace"`
		} `json:"kept"`
	}
	if err := json.Unmarshal(second.Body.Bytes(), &response); err != nil {
		t.Fatalf("second vote 回應無法解析：%v %s", err, second.Body.String())
	}
	found := false
	for _, candidate := range response.Kept {
		if candidate.RestaurantID != targetID {
			continue
		}
		for _, entry := range candidate.Trace {
			if entry.Factor == "exposure" {
				found = true
				if entry.Mult != 1.0 || strings.Contains(entry.Reason, "新出現") {
					t.Fatalf("未在 search 計入曝光的候選不可扣 baseline：got %+v", entry)
				}
			}
		}
	}
	if !found {
		t.Fatal("target candidate 缺少 exposure trace")
	}
	var counted bool
	if err := pool.QueryRow(ctx, `select exposure_counted from public.room_candidates
		where room_id = $1 and restaurant_id = $2`, roomID, targetID).Scan(&counted); err != nil {
		t.Fatal(err)
	}
	if counted {
		t.Fatal("兩次 rescore 後 exposure_counted 不可由 false 變 true")
	}
}

func TestRateLimit429(t *testing.T) {
	h := rateLimit(newLimiterStore(RateLimitPerSec, RateLimitBurst),
		http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusOK) }))
	last := 0
	for i := 0; i < RateLimitBurst+1; i++ {
		w := httptest.NewRecorder()
		h.ServeHTTP(w, httptest.NewRequest("POST", "/x", nil))
		last = w.Code
	}
	if last != http.StatusTooManyRequests {
		t.Fatalf("第 %d 個連發請求應 429，got %d", RateLimitBurst+1, last)
	}
}

func TestSearchEdgeCases(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	// 先註冊 = 後執行（Cleanup 為 LIFO）：確保下方刪 room 的 cleanup 在 pool 關閉前跑完，
	// 否則 delete 打在已關閉的 pool 上被靜默丟棄，殘留的 draws 列會讓下次執行的 draw 直接 409
	t.Cleanup(func() { pool.Close() })

	hostID := "33333333-3333-3333-3333-333333333333"
	strangerID := "44444444-4444-4444-4444-444444444444"
	roomID := "55555555-5555-5555-5555-555555555555"
	if _, err = pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'host2@test.dev') on conflict do nothing`,
		hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	// budget_max=50：所有 price level 換算金額都 >50 → 全數排除 → 422
	if _, err = pool.Exec(ctx,
		`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		 values ($1, $2, 50, '["japanese"]', 2000, 'walking')
		 on conflict (room_id, user_id) do update set budget_max = 50`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID) })

	persistedPlaceID := "mock-cache-persistence-422"
	strictRestaurant := Restaurant{
		PlaceID: persistedPlaceID, Name: "零候選快取測試", PrimaryType: "restaurant", PriceLevel: 0,
		Lat: 25.0478, Lng: 121.5170, Hours: daily([2]int{0, 1440}),
	}
	if _, err := pool.Exec(ctx, `delete from restaurants where place_id = $1`, persistedPlaceID); err != nil {
		t.Fatal(err)
	}
	// 重複 place_id 同時鎖住 provider seam 去重；否則 budget 統計會變成 2。
	h := newTestAppWithProvider(t, pool, fixedProvider{strictRestaurant, strictRestaurant})
	do := func(token, path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	hostTok := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	strangerTok := signHS256(t, "test-secret-test-secret-test-secret!", strangerID)

	if w := do(strangerTok, "/api/rooms/"+roomID+"/search"); w.Code != http.StatusForbidden {
		t.Fatalf("非房主 search: want 403 got %d", w.Code)
	}
	if w := do(strangerTok, "/api/rooms/66666666-6666-6666-6666-666666666666/search"); w.Code != http.StatusNotFound {
		t.Fatalf("不存在的房: want 404 got %d", w.Code)
	}
	if w := do(hostTok, "/api/rooms/not-a-uuid/search"); w.Code != http.StatusNotFound {
		t.Fatalf("非法 room id: want 404 got %d body %s", w.Code, w.Body.String())
	}
	w := do(hostTok, "/api/rooms/"+roomID+"/search")
	if w.Code != http.StatusUnprocessableEntity {
		t.Fatalf("全排除: want 422 got %d body %s", w.Code, w.Body.String())
	}
	var body struct {
		ExcludedBy map[string]int `json:"excluded_by"`
		Degraded   *bool          `json:"degraded"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || body.ExcludedBy["budget"] != 1 {
		t.Fatalf("422 應含 excluded_by.budget 統計：%s", w.Body.String())
	}
	if body.Degraded == nil || *body.Degraded {
		t.Fatalf("非降級 422 應明確含 degraded=false：%s", w.Body.String())
	}
	emptyApp := newTestAppWithProvider(t, pool, fixedProvider{})
	emptyRequest := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	emptyRequest.Header.Set("Authorization", "Bearer "+hostTok)
	emptyResponse := httptest.NewRecorder()
	emptyApp.ServeHTTP(emptyResponse, emptyRequest)
	var emptyBody struct {
		Error    string `json:"error"`
		Degraded *bool  `json:"degraded"`
	}
	if err := json.Unmarshal(emptyResponse.Body.Bytes(), &emptyBody); err != nil ||
		emptyResponse.Code != http.StatusUnprocessableEntity ||
		emptyBody.Error != "no_restaurants_in_range" || emptyBody.Degraded == nil || *emptyBody.Degraded {
		t.Fatalf("無餐廳 422 應明確含 degraded=false：status %d body %s", emptyResponse.Code, emptyResponse.Body.String())
	}
	var cached int
	if err := pool.QueryRow(ctx, `select count(*) from restaurants where place_id like 'mock-%'`).Scan(&cached); err != nil || cached == 0 {
		t.Fatalf("零候選 rollback 後 provider 結果仍應留在快取，got %d err %v", cached, err)
	}
	var persisted bool
	if err := pool.QueryRow(ctx, `select exists (select 1 from restaurants where place_id = $1)`, persistedPlaceID).Scan(&persisted); err != nil || !persisted {
		t.Fatalf("422 後專用 provider row 應留在快取，got %v err %v", persisted, err)
	}
	var status string
	if err := pool.QueryRow(ctx, `select status from public.rooms where id = $1`, roomID).
		Scan(&status); err != nil || status != "lobby" {
		t.Fatalf("零候選後房間應停留在 lobby，got %q err %v", status, err)
	}
}

func TestSearchFallsBackToCache(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "21212121-2121-2121-2121-212121212121"
	roomID := "22222222-2222-2222-2222-222222222222"
	if _, err = pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'fb@test.dev') on conflict do nothing`,
		hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		 values ($1, $2, 500, '["japanese"]', 2000, 'walking') on conflict do nothing`,
		roomID, hostID); err != nil {
		t.Fatal(err)
	}
	// 先種一筆 30 天內的快取（mock 資料座標圈內）
	if _, err = pool.Exec(ctx, `
		insert into public.restaurants (place_id, name, primary_type, cuisine_tags, price_level, lat, lng, opening_hours, source, fetched_at)
		values ('cached-1', '快取餐廳', 'restaurant', '["japanese"]', 1, 25.0478, 121.5172,
		        '{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}',
		        'google', now())
		on conflict (place_id) do update set primary_type = excluded.primary_type, fetched_at = now()`); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})

	t.Setenv("SUPABASE_JWT_SECRET", "test-secret-test-secret-test-secret!")
	t.Setenv("SUPABASE_JWKS_URL", "")
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	h := buildRoutes(v, pool, failingProvider{}, nil, newLimiterStore(1000, 1000))
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("有快取時應降級成功：want 200 got %d body %s", w.Code, w.Body.String())
	}
	var body struct {
		Degraded bool `json:"degraded"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil || !body.Degraded {
		t.Fatalf("降級回應應含 degraded=true：%s", w.Body.String())
	}
}

func TestSearchRejectedAndClosedPlacesTombstoneCache(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID          = "71717171-7171-7171-7171-717171717171"
		freshRoomID     = "72727272-7272-7272-7272-727272727272"
		fallbackRoomID  = "73737373-7373-7373-7373-737373737373"
		closedPlaceID   = "round12-closed-place"
		rejectedPlaceID = "round7-rejected-place"
		openPlaceID     = "round12-open-place"
	)
	if _, err = pool.Exec(ctx, `insert into auth.users (id, email)
		values ($1, 'closed-cache@test.dev') on conflict do nothing`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $3, 'lobby', 24.1988, 121.6543), ($2, $3, 'lobby', 24.1988, 121.6543)
		on conflict (id) do update set status = 'lobby', center_lat = excluded.center_lat,
			center_lng = excluded.center_lng`, freshRoomID, fallbackRoomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		values ($1, $3, 500, '[]', 2000, 'walking'), ($2, $3, 500, '[]', 2000, 'walking')
		on conflict (room_id, user_id) do update set budget_max = excluded.budget_max,
			cuisines = excluded.cuisines, max_distance_m = excluded.max_distance_m,
			transport = excluded.transport`, freshRoomID, fallbackRoomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.restaurants
		(place_id, name, primary_type, cuisine_tags, price_level, lat, lng, opening_hours, source, fetched_at)
		values ($1, '已歇業快取餐廳', 'restaurant', '[]', 1, 24.1988, 121.6543,
		'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}', 'google', now())
		on conflict (place_id) do update set primary_type = excluded.primary_type, fetched_at = now()`, closedPlaceID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.restaurants
		(place_id, name, primary_type, cuisine_tags, price_level, lat, lng, opening_hours, source, fetched_at)
		values ($1, '主類型被拒絕的快取列', 'restaurant', '[]', 1, 24.1988, 121.6543,
		'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}', 'google', now())
		on conflict (place_id) do update set primary_type = excluded.primary_type, fetched_at = now()`, rejectedPlaceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
		pool.Exec(ctx, `delete from public.rooms where id in ($1, $2)`, freshRoomID, fallbackRoomID)
		pool.Exec(ctx, `delete from public.restaurants where place_id in ($1, $2, $3)`, closedPlaceID, rejectedPlaceID, openPlaceID)
	})

	var closedRestaurantID, rejectedRestaurantID string
	if err := pool.QueryRow(ctx, `select id from public.restaurants where place_id = $1`, closedPlaceID).
		Scan(&closedRestaurantID); err != nil {
		t.Fatal(err)
	}
	if err := pool.QueryRow(ctx, `select id from public.restaurants where place_id = $1`, rejectedPlaceID).
		Scan(&rejectedRestaurantID); err != nil {
		t.Fatal(err)
	}
	open := Restaurant{
		PlaceID: openPlaceID, Name: "仍營業餐廳", PrimaryType: "restaurant", PriceLevel: 1,
		Lat: 24.1988, Lng: 121.6543, Hours: daily([2]int{0, 1440}),
	}
	closed := Restaurant{
		PlaceID: closedPlaceID, Name: "已歇業快取餐廳", PrimaryType: "restaurant", PriceLevel: 1,
		Lat: 24.1988, Lng: 121.6543, Hours: daily([2]int{0, 1440}), Closed: true,
	}
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	doSearch := func(h http.Handler, roomID string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	assertStaleAbsent := func(w *httptest.ResponseRecorder, degraded bool) {
		t.Helper()
		if w.Code != http.StatusOK {
			t.Fatalf("search: want 200 got %d body %s", w.Code, w.Body.String())
		}
		var body struct {
			Kept []struct {
				RestaurantID string `json:"restaurant_id"`
			} `json:"kept"`
			Degraded bool `json:"degraded"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("decode search response: %v body %s", err, w.Body.String())
		}
		if body.Degraded != degraded {
			t.Fatalf("degraded = %v, want %v body %s", body.Degraded, degraded, w.Body.String())
		}
		staleRestaurantIDs := map[string]bool{closedRestaurantID: true, rejectedRestaurantID: true}
		for _, kept := range body.Kept {
			if staleRestaurantIDs[kept.RestaurantID] {
				t.Fatalf("stale restaurant %s must be absent: %s", kept.RestaurantID, w.Body.String())
			}
		}
	}

	provider := resultProvider{result: PlacesSearchResult{
		Restaurants:      []Restaurant{closed, open},
		RejectedPlaceIDs: []string{rejectedPlaceID},
	}}
	assertStaleAbsent(doSearch(newTestAppWithProvider(t, pool, provider), freshRoomID), false)
	for _, placeID := range []string{closedPlaceID, rejectedPlaceID} {
		var fetchedAt time.Time
		if err := pool.QueryRow(ctx, `select fetched_at from public.restaurants where place_id = $1`, placeID).
			Scan(&fetchedAt); err != nil {
			t.Fatal(err)
		}
		if !fetchedAt.Before(time.Now().Add(-30 * 24 * time.Hour)) {
			t.Fatalf("stale restaurant %s fetched_at must be older than 30 days, got %s", placeID, fetchedAt)
		}
	}

	assertStaleAbsent(doSearch(newTestAppWithProvider(t, pool, failingProvider{}), fallbackRoomID), true)
}

func TestSearchFallbackAllExcludedIncludesDegraded(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID  = "31313131-3131-3131-3131-313131313131"
		roomID  = "32323232-3232-3232-3232-323232323232"
		placeID = "cached-degraded-excluded"
	)
	if _, err = pool.Exec(ctx, `insert into auth.users (id, email)
		values ($1, 'degraded-422@test.dev') on conflict do nothing`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 23.9911, 121.6112)
		on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		values ($1, $2, 50, '[]', 2000, 'walking') on conflict do nothing`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.restaurants
		(place_id, name, primary_type, cuisine_tags, price_level, lat, lng, opening_hours, source, fetched_at)
		values ($1, '降級全排除快取', 'restaurant', '[]', 1, 23.9911, 121.6112,
		'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}', 'google', now())
		on conflict (place_id) do update set primary_type = excluded.primary_type, fetched_at = now()`, placeID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.restaurants where place_id = $1`, placeID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})

	h := newTestAppWithProvider(t, pool, failingProvider{})
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", hostID))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	var body struct {
		Error    string `json:"error"`
		Degraded bool   `json:"degraded"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil ||
		w.Code != http.StatusUnprocessableEntity || body.Error != "no_candidates" || !body.Degraded {
		t.Fatalf("降級全排除應回 422 degraded=true：status %d body %s", w.Code, w.Body.String())
	}
}

func TestSearchNoCacheReturns502(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "23232323-2323-2323-2323-232323232323"
	roomID := "24242424-2424-2424-2424-242424242424"
	if _, err = pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'nc@test.dev') on conflict do nothing`,
		hostID); err != nil {
		t.Fatal(err)
	}
	// 快取圈外的座標（高雄）→ 30 天內快取為空
	if _, err = pool.Exec(ctx, `insert into public.rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 22.6273, 120.3014)
		on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.room_members (room_id, user_id) values ($1, $2) on conflict do nothing`,
		roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID) })

	t.Setenv("SUPABASE_JWT_SECRET", "test-secret-test-secret-test-secret!")
	t.Setenv("SUPABASE_JWKS_URL", "")
	v, err := NewVerifier()
	if err != nil {
		t.Fatal(err)
	}
	h := buildRoutes(v, pool, failingProvider{}, nil, newLimiterStore(1000, 1000))
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", hostID))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("無快取時 want 502 got %d body %s", w.Code, w.Body.String())
	}
}

func TestGoogleSearchDoesNotFallbackToMockCache(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID  = "41414141-4141-4141-4141-414141414141"
		roomID  = "42424242-4242-4242-4242-424242424242"
		placeID = "mock-google-fallback-only"
		// 交叉案例：place_id 不帶 mock- 前綴，出身只寫在 source 欄。
		crossPlaceID = "sourced-mock-no-prefix"
	)
	if _, err = pool.Exec(ctx, `insert into auth.users (id, email)
		values ($1, 'google-cache@test.dev') on conflict do nothing`, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.rooms (id, host_id, status, center_lat, center_lng)
		values ($1, $2, 'lobby', 23.5685, 119.5660)
		on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.room_members
		(room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		values ($1, $2, 500, '[]', 2000, 'walking') on conflict do nothing`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	// source='mock' 需顯式指定：0013 後過濾依 source 欄而非 place_id 前綴，
	// 本列模擬的正是 mock provider 寫入的快取。
	if _, err = pool.Exec(ctx, `insert into public.restaurants
		(place_id, name, primary_type, cuisine_tags, price_level, lat, lng, opening_hours, source, fetched_at)
		values ($1, '不可供 Google 使用的 mock 快取', 'restaurant', '[]', 1, 23.5685, 119.5660,
		'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}', 'mock', now())
		on conflict (place_id) do update set primary_type = excluded.primary_type, source = excluded.source, fetched_at = now()`, placeID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `insert into public.restaurants
		(place_id, name, primary_type, cuisine_tags, price_level, lat, lng, opening_hours, source, fetched_at)
		values ($1, '前綴不像 mock 的 mock 快取', 'restaurant', '[]', 1, 23.5685, 119.5660,
		'{"sun":[[0,1440]],"mon":[[0,1440]],"tue":[[0,1440]],"wed":[[0,1440]],"thu":[[0,1440]],"fri":[[0,1440]],"sat":[[0,1440]]}', 'mock', now())
		on conflict (place_id) do update set primary_type = excluded.primary_type, source = excluded.source, fetched_at = now()`, crossPlaceID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.restaurants where place_id = any($1)`,
			[]string{placeID, crossPlaceID})
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})
	nearbyCache, err := LoadCachedRestaurants(ctx, pool, 23.5685, 119.5660, 2000, false)
	seeded := map[string]bool{}
	for _, r := range nearbyCache {
		seeded[r.PlaceID] = true
	}
	if err != nil || len(nearbyCache) != 2 || !seeded[placeID] || !seeded[crossPlaceID] {
		t.Fatalf("test precondition requires only the two fresh mock cache rows nearby: got %+v err %v", nearbyCache, err)
	}
	// 出身只認 source 欄：前綴看不出是 mock 的那列同樣要被擋掉，
	// 否則 place_id 前綴 sniff 復辟時這條回歸線會失效。
	googleOnly, err := LoadCachedRestaurants(ctx, pool, 23.5685, 119.5660, 2000, true)
	if err != nil || len(googleOnly) != 0 {
		t.Fatalf("excludeMock 必須排除所有 source='mock' 的列（含非 mock- 前綴者）：got %+v err %v", googleOnly, err)
	}

	var attempts atomic.Int32
	deadGoogle := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		attempts.Add(1)
		http.Error(w, "simulated Google outage", http.StatusInternalServerError)
	}))
	t.Cleanup(deadGoogle.Close)
	h := newTestAppWithProvider(t, pool, NewGooglePlacesProvider("k", deadGoogle.URL))
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/search", nil)
	r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", hostID))
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusBadGateway {
		t.Fatalf("Google fallback must refuse mock cache: want 502 got %d body %s", w.Code, w.Body.String())
	}
	if got := attempts.Load(); got != 2 {
		t.Fatalf("Google provider must retry once before fallback: want 2 attempts got %d", got)
	}
}

func TestSearchDrawRecordsHistory(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "77777777-7777-7777-7777-777777777777"
	roomID := "88888888-8888-8888-8888-888888888888"
	if _, err = pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'hist@test.dev') on conflict do nothing`,
		hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		 values ($1, $2, 500, '["japanese"]', 2000, 'walking') on conflict do nothing`,
		roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.dining_history where room_id = $1`, roomID)
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})

	h := newTestApp(t, pool)
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	do := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}

	if w := do("/api/rooms/" + roomID + "/search"); w.Code != http.StatusOK {
		t.Fatalf("search: want 200 got %d body %s", w.Code, w.Body.String())
	}
	var recommended int
	if err := pool.QueryRow(ctx,
		`select count(*) from public.exposure_stats
		 where user_id = $1 and recommended_count > 0`, hostID).Scan(&recommended); err != nil {
		t.Fatal(err)
	}
	if recommended == 0 {
		t.Fatal("search 後 exposure_stats.recommended_count 應有紀錄")
	}
	if w := do("/api/rooms/" + roomID + "/start-voting"); w.Code != http.StatusOK {
		t.Fatalf("start-voting: want 200 got %d body %s", w.Code, w.Body.String())
	}

	if w := do("/api/rooms/" + roomID + "/draw"); w.Code != http.StatusOK {
		t.Fatalf("draw: want 200 got %d body %s", w.Code, w.Body.String())
	}
	var histCount, prefHitCount, chosenCount int
	if err := pool.QueryRow(ctx,
		`select count(*), count(pref_hit) from public.dining_history where room_id = $1 and user_id = $2`,
		roomID, hostID).Scan(&histCount, &prefHitCount); err != nil {
		t.Fatal(err)
	}
	if histCount != 1 {
		t.Fatalf("draw 後每位成員應有 1 筆同席紀錄，got %d", histCount)
	}
	if prefHitCount != 1 {
		t.Fatalf("有偏好成員的同席紀錄應寫入 pref_hit，got %d", prefHitCount)
	}
	if err := pool.QueryRow(ctx,
		`select count(*) from public.exposure_stats
		 where user_id = $1 and chosen_count > 0 and last_chosen_at is not null`,
		hostID).Scan(&chosenCount); err != nil {
		t.Fatal(err)
	}
	if chosenCount != 1 {
		t.Fatalf("draw 後 winner 的 chosen_count 應 +1，got %d", chosenCount)
	}
}

func TestLoadRecencyBuckets(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	u1 := "99999999-9999-9999-9999-999999999999"
	u2 := "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"
	u3 := "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"
	r1 := "cccccccc-cccc-cccc-cccc-cccccccccccc"
	roomIDs := []string{
		"dddddddd-dddd-dddd-dddd-dddddddddddd",
		"eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee",
		"ffffffff-ffff-ffff-ffff-ffffffffffff",
		"12121212-1212-1212-1212-121212121212",
	}

	if _, err = pool.Exec(ctx, `
		insert into auth.users (id, email) values
		  ($1, 'recency-u1@test.dev'),
		  ($2, 'recency-u2@test.dev'),
		  ($3, 'recency-u3@test.dev')
		on conflict do nothing`, u1, u2, u3); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		insert into public.restaurants (id, place_id, name, lat, lng, source)
		values ($1, 'recency-r1', 'Recency R1', 25.0478, 121.5170, 'google')
		on conflict (id) do nothing`, r1); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx, `
		insert into public.rooms (id, host_id, status) values
		  ($1, $5, 'decided'),
		  ($2, $5, 'decided'),
		  ($3, $5, 'decided'),
		  ($4, $5, 'decided')
		on conflict (id) do nothing`, roomIDs[0], roomIDs[1], roomIDs[2], roomIDs[3], u1); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.dining_history where room_id = any($1::uuid[])`, roomIDs)
		pool.Exec(ctx, `delete from public.rooms where id = any($1::uuid[])`, roomIDs)
		pool.Exec(ctx, `delete from public.restaurants where id = $1`, r1)
		pool.Exec(ctx, `delete from auth.users where id = any($1::uuid[])`, []string{u1, u2, u3})
	})

	if _, err = pool.Exec(ctx, `
		insert into public.dining_history (user_id, restaurant_id, room_id, decided_at) values
		  ($1, $4, $5, now() - interval '10 days'),
		  ($2, $4, $6, now() - interval '20 days'),
		  ($3, $4, $7, now() - interval '40 days'),
		  ($1, $4, $8, now() - interval '25 days')`,
		u1, u2, u3, r1, roomIDs[0], roomIDs[1], roomIDs[2], roomIDs[3]); err != nil {
		t.Fatal(err)
	}

	got, err := LoadRecency(ctx, pool, []string{u1, u2, u3}, []string{r1})
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 1 || got[r1].Fresh != 1 || got[r1].Fading != 1 {
		t.Fatalf("LoadRecency = %#v, want map[%s:{Fresh:1 Fading:1}]", got, r1)
	}
}

func TestVotingFlow(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "71717171-7171-7171-7171-717171717171"
	memberID := "72727272-7272-7272-7272-727272727272"
	strangerID := "73737373-7373-7373-7373-737373737373"
	roomID := "74747474-7474-7474-7474-747474747474"
	if _, err = pool.Exec(ctx, `
		insert into auth.users (id, email) values
		  ($1, 'vhost@test.dev'), ($2, 'vmember@test.dev'), ($3, 'vstranger@test.dev')
		on conflict do nothing`, hostID, memberID, strangerID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{hostID, memberID} {
		if _, err = pool.Exec(ctx,
			`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
			 values ($1, $2, 500, '["japanese"]', 2000, 'walking') on conflict do nothing`,
			roomID, uid); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.dining_history where room_id = $1`, roomID)
		pool.Exec(ctx, `delete from public.exposure_stats where user_id in ($1, $2)`, hostID, memberID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})

	h := newTestApp(t, pool)
	do := func(uid, path, body string) *httptest.ResponseRecorder {
		var rd io.Reader
		if body != "" {
			rd = strings.NewReader(body)
		}
		r := httptest.NewRequest("POST", path, rd)
		r.Header.Set("Authorization", "Bearer "+signHS256(t, "test-secret-test-secret-test-secret!", uid))
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	vote := func(uid, rid, kind, op string) *httptest.ResponseRecorder {
		return do(uid, "/api/rooms/"+roomID+"/vote",
			fmt.Sprintf(`{"restaurant_id":%q,"kind":%q,"op":%q}`, rid, kind, op))
	}
	myVotes := func(kind string) int {
		var n int
		if err := pool.QueryRow(ctx, `select count(*) from public.votes
			where room_id = $1 and user_id = $2 and kind = $3`,
			roomID, memberID, kind).Scan(&n); err != nil {
			t.Fatal(err)
		}
		return n
	}

	// vote 在 voting 前不可用；start-voting 僅房主
	if w := do(hostID, "/api/rooms/"+roomID+"/search", ""); w.Code != http.StatusOK {
		t.Fatalf("search: %d %s", w.Code, w.Body.String())
	}
	// 只取 kept：excluded 列無 weight_breakdown，且 uuid 排序在每次 reset 間隨機
	var cands []string
	rows, err := pool.Query(ctx, `select restaurant_id from public.room_candidates
		where room_id = $1 and status = 'kept' order by restaurant_id`, roomID)
	if err != nil {
		t.Fatal(err)
	}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		cands = append(cands, id)
	}
	rows.Close()
	if len(cands) < 3 {
		t.Fatalf("測試需要至少 3 家候選，got %d", len(cands))
	}
	if w := vote(memberID, cands[0], "up", "cast"); w.Code != http.StatusConflict {
		t.Fatalf("candidates 階段 vote: want 409 got %d", w.Code)
	}
	if w := do(memberID, "/api/rooms/"+roomID+"/start-voting", ""); w.Code != http.StatusForbidden {
		t.Fatalf("非房主 start-voting: want 403 got %d", w.Code)
	}
	if w := do(hostID, "/api/rooms/"+roomID+"/start-voting", ""); w.Code != http.StatusOK {
		t.Fatalf("start-voting: %d %s", w.Code, w.Body.String())
	}
	if w := do(hostID, "/api/rooms/"+roomID+"/start-voting", ""); w.Code != http.StatusConflict {
		t.Fatalf("重複 start-voting: want 409 got %d", w.Code)
	}
	if w := do(memberID, "/api/rooms/"+roomID+"/vote", fmt.Sprintf(
		`{"restaurant_id":%q,"kind":"up","op":"cast","padding":%q}`,
		cands[0], strings.Repeat("x", 1<<10))); w.Code < 400 || w.Code >= 500 {
		t.Fatalf("超過 1KB 的 vote body: want 4xx got %d", w.Code)
	}

	// cast up：成功 + 冪等（重複 cast 不變）；trace 出現投票因素
	if w := vote(memberID, cands[0], "up", "cast"); w.Code != http.StatusOK {
		t.Fatalf("vote up: %d %s", w.Code, w.Body.String())
	}
	if w := vote(memberID, cands[0], "up", "cast"); w.Code != http.StatusOK || myVotes("up") != 1 {
		t.Fatalf("重複 cast 應冪等：%d，up=%d", w.Code, myVotes("up"))
	}
	var trace string
	if err := pool.QueryRow(ctx,
		`select weight_breakdown::text from public.room_candidates
		 where room_id = $1 and restaurant_id = $2`, roomID, cands[0]).Scan(&trace); err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(trace, `"votes"`) || !strings.Contains(trace, "1 張贊成票") {
		t.Fatalf("vote 後 trace 應含投票因素：%s", trace)
	}

	// 互斥：同店 cast veto → up 自動撤；回應含剩餘否決額度
	wv := vote(memberID, cands[0], "veto", "cast")
	if wv.Code != http.StatusOK {
		t.Fatalf("veto: %d %s", wv.Code, wv.Body.String())
	}
	var vetoResp struct {
		VetoesRemaining int `json:"vetoes_remaining"`
		Excluded        []struct {
			Kinds []string `json:"kinds"`
		} `json:"excluded"`
	}
	if err := json.Unmarshal(wv.Body.Bytes(), &vetoResp); err != nil || vetoResp.VetoesRemaining != VetoQuota-1 {
		t.Fatalf("第 1 個否決後 vetoes_remaining 應為 %d：%v %s", VetoQuota-1, err, wv.Body.String())
	}
	// arch c3：否決產生的 excluded 要帶結構化 kinds（client 死路判定的 contract）
	vetoKind := false
	for _, e := range vetoResp.Excluded {
		vetoKind = vetoKind || hasKind(e.Kinds, "veto")
	}
	if !vetoKind {
		t.Fatalf("veto 後 excluded 應含 kinds=[veto]：%s", wv.Body.String())
	}
	if myVotes("up") != 0 || myVotes("veto") != 1 {
		t.Fatalf("互斥失敗：up=%d veto=%d", myVotes("up"), myVotes("veto"))
	}

	// 限額：第 2 個否決 OK、第 3 個（他店）409；收回後釋放
	if w := vote(memberID, cands[1], "veto", "cast"); w.Code != http.StatusOK {
		t.Fatalf("第 2 個否決: %d %s", w.Code, w.Body.String())
	}
	w3 := vote(memberID, cands[2], "veto", "cast")
	if w3.Code != http.StatusConflict || !strings.Contains(w3.Body.String(), "否決額度已用完") {
		t.Fatalf("第 3 個否決應 409 含額度訊息：%d %s", w3.Code, w3.Body.String())
	}
	if w := vote(memberID, cands[0], "veto", "retract"); w.Code != http.StatusOK {
		t.Fatalf("收回: %d %s", w.Code, w.Body.String())
	}
	if w := vote(memberID, cands[0], "veto", "retract"); w.Code != http.StatusOK {
		t.Fatalf("重複收回應冪等: %d", w.Code)
	}
	if w := vote(memberID, cands[2], "veto", "cast"); w.Code != http.StatusOK {
		t.Fatalf("收回後額度應釋放: %d %s", w.Code, w.Body.String())
	}

	// 非成員 403；不在候選名單的餐廳 422
	if w := vote(strangerID, cands[0], "up", "cast"); w.Code != http.StatusForbidden {
		t.Fatalf("非成員 vote: want 403 got %d", w.Code)
	}
	for _, rid := range []string{"", "not-a-uuid"} {
		if w := vote(memberID, rid, "up", "cast"); w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "餐廳 ID 格式不正確") {
			t.Fatalf("非法 restaurant_id vote: want 422 with message got %d %s", w.Code, w.Body.String())
		}
	}
	if w := vote(memberID, "00000000-0000-0000-0000-00000000dead", "up", "cast"); w.Code != http.StatusUnprocessableEntity || !strings.Contains(w.Body.String(), "不在本房的候選名單中") {
		t.Fatalf("非候選餐廳 vote: want 422 with message got %d %s", w.Code, w.Body.String())
	}

	// 全否決前先清掉 member 的否決（host 無票）→ draw 從 voting 出發
	if _, err := pool.Exec(ctx,
		`delete from public.votes where room_id = $1`, roomID); err != nil {
		t.Fatal(err)
	}
	if w := do(hostID, "/api/rooms/"+roomID+"/draw", ""); w.Code != http.StatusOK {
		t.Fatalf("draw: %d %s", w.Code, w.Body.String())
	}

	// D7：decided 後 vote 應 409（條件鎖擋晚到的投票）
	if w := vote(memberID, cands[0], "up", "cast"); w.Code != http.StatusConflict {
		t.Fatalf("decided 後 vote: want 409 got %d", w.Code)
	}
}

func TestDrawAllVetoed(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "13131313-1313-1313-1313-131313131313"
	memberID := "14141414-1414-1414-1414-141414141414"
	roomID := "15151515-1515-1515-1515-151515151515"
	if _, err = pool.Exec(ctx, `
		insert into auth.users (id, email) values
		  ($1, 'veto-host@test.dev'), ($2, 'veto-member@test.dev')
		on conflict do nothing`, hostID, memberID); err != nil {
		t.Fatal(err)
	}
	if _, err = pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	for _, uid := range []string{hostID, memberID} {
		if _, err = pool.Exec(ctx,
			`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
			 values ($1, $2, 500, '["japanese"]', 2000, 'walking') on conflict do nothing`,
			roomID, uid); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.dining_history where room_id = $1`, roomID)
		pool.Exec(ctx, `delete from public.exposure_stats where user_id in ($1, $2)`, hostID, memberID)
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
	})

	h := newTestApp(t, pool)
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	do := func(path string) *httptest.ResponseRecorder {
		r := httptest.NewRequest("POST", path, nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		return w
	}
	if w := do("/api/rooms/" + roomID + "/search"); w.Code != http.StatusOK {
		t.Fatalf("search: want 200 got %d body %s", w.Code, w.Body.String())
	}
	if w := do("/api/rooms/" + roomID + "/start-voting"); w.Code != http.StatusOK {
		t.Fatalf("start-voting: want 200 got %d body %s", w.Code, w.Body.String())
	}

	rows, err := pool.Query(ctx, `select restaurant_id from public.room_candidates
		where room_id = $1 and status = 'kept' order by restaurant_id`, roomID)
	if err != nil {
		t.Fatal(err)
	}
	var kept []string
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			t.Fatal(err)
		}
		kept = append(kept, id)
	}
	rows.Close()
	if len(kept) == 0 {
		t.Fatal("測試需要至少 1 家 kept 候選")
	}
	for i, rid := range kept {
		uid := hostID
		if i%2 == 1 {
			uid = memberID
		}
		if _, err := pool.Exec(ctx, `insert into public.votes (room_id, user_id, restaurant_id, kind)
			values ($1, $2, $3, 'veto')`, roomID, uid, rid); err != nil {
			t.Fatal(err)
		}
	}

	w := do("/api/rooms/" + roomID + "/draw")
	if w.Code != http.StatusConflict ||
		!strings.Contains(w.Body.String(), "候選已全數被否決，請成員收回否決後再抽選") {
		t.Fatalf("全否決 draw 應 409 且有專用訊息：%d %s", w.Code, w.Body.String())
	}
	var status string
	if err := pool.QueryRow(ctx, `select status from public.rooms where id = $1`, roomID).Scan(&status); err != nil || status != "voting" {
		t.Fatalf("全否決後房間應停留在 voting，got %q err %v", status, err)
	}
}

func TestSearchExposureOrderingNewStoreBonus(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "31313131-3131-3131-3131-313131313131"
	roomA := "32323232-3232-3232-3232-323232323232"
	roomB := "34343434-3434-3434-3434-343434343434"
	if _, err := pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'exposure@test.dev') on conflict do nothing`,
		hostID); err != nil {
		t.Fatal(err)
	}
	for _, rid := range []string{roomA, roomB} {
		if _, err := pool.Exec(ctx,
			`insert into public.rooms (id, host_id, status, center_lat, center_lng)
			 values ($1, $2, 'lobby', 25.0478, 121.5170)
			 on conflict (id) do update set status = 'lobby'`, rid, hostID); err != nil {
			t.Fatal(err)
		}
		if _, err := pool.Exec(ctx,
			`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
			 values ($1, $2, 1600, '["japanese"]', 2000, 'walking') on conflict do nothing`,
			rid, hostID); err != nil {
			t.Fatal(err)
		}
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.rooms where id = any($1::uuid[])`, []string{roomA, roomB})
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
	})

	h := newTestApp(t, pool)
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	exposureTrace := func(roomID string) (TraceEntry, bool) {
		r := httptest.NewRequest("POST", fmt.Sprintf("/api/rooms/%s/search", roomID), nil)
		r.Header.Set("Authorization", "Bearer "+token)
		w := httptest.NewRecorder()
		h.ServeHTTP(w, r)
		if w.Code != http.StatusOK {
			t.Fatalf("search %s: want 200 got %d body %s", roomID, w.Code, w.Body.String())
		}
		var sr struct {
			Kept []struct {
				Trace []TraceEntry `json:"trace"`
			} `json:"kept"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &sr); err != nil || len(sr.Kept) == 0 {
			t.Fatalf("kept 不可為空：%v %s", err, w.Body.String())
		}
		for _, e := range sr.Kept[0].Trace {
			if e.Factor == "exposure" {
				return e, true
			}
		}
		return TraceEntry{}, false
	}

	// 房 A 首搜：全場皆新 → 中性、無 exposure chip（D21）。
	// 順序證明：若 RecordExposure 誤移到 Evaluate 之前，房 A 就會看到「推薦過」trace。
	if e, ok := exposureTrace(roomA); ok {
		t.Fatalf("房 A 首搜全場皆新，不應有 exposure trace（若出現「推薦過」= 順序被打破），got %+v", e)
	}
	// 房 B：同批餐廳已在房 A 被推薦 → 「推薦過但尚未中選」具名中性 trace
	if e, ok := exposureTrace(roomB); !ok || e.Mult != 1.0 || !strings.Contains(e.Reason, "推薦過") {
		t.Fatalf("房 B 應為「推薦過但尚未中選」中性，got %+v ok=%v", e, ok)
	}
}

func TestSearchSurvivesWeatherOutage(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	hostID := "35353535-3535-3535-3535-353535353535"
	roomID := "36363636-3636-3636-3636-363636363636"
	if _, err := pool.Exec(ctx,
		`insert into auth.users (id, email) values ($1, 'weather@test.dev') on conflict do nothing`,
		hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into public.rooms (id, host_id, status, center_lat, center_lng)
		 values ($1, $2, 'lobby', 25.0478, 121.5170)
		 on conflict (id) do update set status = 'lobby'`, roomID, hostID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx,
		`insert into public.room_members (room_id, user_id, budget_max, cuisines, max_distance_m, transport)
		 values ($1, $2, 1600, '["japanese"]', 2000, 'walking') on conflict do nothing`,
		roomID, hostID); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		pool.Exec(ctx, `delete from public.rooms where id = $1`, roomID)
		pool.Exec(ctx, `delete from public.exposure_stats where user_id = $1`, hostID)
	})

	h := newTestAppWithWeather(t, pool, NewMockProvider(), failingWeather{})
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	r := httptest.NewRequest("POST", fmt.Sprintf("/api/rooms/%s/search", roomID), nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("天氣故障不得阻斷 search：want 200 got %d body %s", w.Code, w.Body.String())
	}
	var sr struct {
		Kept []struct {
			Trace []TraceEntry `json:"trace"`
		} `json:"kept"`
	}
	if err := json.Unmarshal(w.Body.Bytes(), &sr); err != nil || len(sr.Kept) == 0 {
		t.Fatalf("kept 不可為空：%v %s", err, w.Body.String())
	}
	for _, e := range sr.Kept[0].Trace {
		if e.Factor == "weather" {
			t.Fatalf("天氣失敗時不得產生 weather trace：%+v", e)
		}
	}
}

func TestVoteUsesCachedWeatherWithoutNetwork(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID       = "37373737-3737-4373-8373-373737373737"
		roomID       = "38383838-3838-4383-8383-383838383838"
		restaurantID = "39393939-3939-4393-8393-393939393939"
	)
	seedVotingRoomCandidate(t, ctx, pool, hostID, roomID, restaurantID,
		"vote-weather@test.dev", "vote-weather-place")

	weather := &countingWeatherProvider{weather: Weather{RainMM: 2}}
	h := newTestAppWithWeather(t, pool, NewMockProvider(), weather)
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	body := fmt.Sprintf(`{"restaurant_id":%q,"kind":"up","op":"cast"}`, restaurantID)
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/vote", strings.NewReader(body))
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)

	if w.Code != http.StatusOK {
		t.Fatalf("vote: want 200 got %d body %s", w.Code, w.Body.String())
	}
	if got := weather.currentCalls.Load(); got != 0 {
		t.Fatalf("vote 不得呼叫 blocking Current：got %d calls", got)
	}
	if got := weather.cachedCalls.Load(); got < 1 {
		t.Fatalf("vote 必須呼叫 CurrentCached，證明 weather wiring 有啟用：got %d calls", got)
	}
}

func TestDrawSurvivesWeatherOutage(t *testing.T) {
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set; run `supabase start` and set it")
	}
	ctx := context.Background()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { pool.Close() })

	const (
		hostID       = "40404040-4040-4040-8040-404040404040"
		roomID       = "41414141-4141-4141-8141-414141414141"
		restaurantID = "42424242-4242-4242-8242-424242424242"
	)
	seedVotingRoomCandidate(t, ctx, pool, hostID, roomID, restaurantID,
		"draw-weather@test.dev", "draw-weather-place")

	h := newTestAppWithWeather(t, pool, NewMockProvider(), failingWeather{})
	token := signHS256(t, "test-secret-test-secret-test-secret!", hostID)
	r := httptest.NewRequest("POST", "/api/rooms/"+roomID+"/draw", nil)
	r.Header.Set("Authorization", "Bearer "+token)
	w := httptest.NewRecorder()
	h.ServeHTTP(w, r)
	if w.Code != http.StatusOK {
		t.Fatalf("天氣故障不得阻斷 draw：want 200 got %d body %s", w.Code, w.Body.String())
	}

	rows, err := pool.Query(ctx, `select weight_breakdown::text from public.room_candidates
		where room_id = $1 and status = 'kept' order by restaurant_id`, roomID)
	if err != nil {
		t.Fatal(err)
	}
	defer rows.Close()
	kept := 0
	for rows.Next() {
		kept++
		var rawTrace string
		if err := rows.Scan(&rawTrace); err != nil {
			t.Fatal(err)
		}
		var trace []TraceEntry
		if err := json.Unmarshal([]byte(rawTrace), &trace); err != nil {
			t.Fatalf("kept candidate trace 無法解析：%v %s", err, rawTrace)
		}
		for _, entry := range trace {
			if entry.Factor == "weather" {
				t.Fatalf("天氣失敗時 kept candidate 不得產生 weather trace：%+v", entry)
			}
		}
	}
	if err := rows.Err(); err != nil {
		t.Fatal(err)
	}
	if kept == 0 {
		t.Fatal("draw 後至少必須保留一個 candidate")
	}
}

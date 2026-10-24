package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"log"
	"net"
	"net/http"
	"net/url"
	"os"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
	"github.com/jackc/pgx/v5/pgtype"
	"github.com/jackc/pgx/v5/pgxpool"
)

func buildRoutes(v *Verifier, pool *pgxpool.Pool, places PlacesProvider, weather WeatherProvider, rl *limiterStore) http.Handler {
	// single-flight 狀態綁在路由實例上，避免跨測試/跨實例透過 process 全域耦合
	var searchInFlight sync.Map
	mux := http.NewServeMux()
	// Supabase signs this hook before a user/session exists; do not put it behind JWT middleware.
	mux.Handle("POST /api/auth/before-user-created", newSignupHook(os.Getenv("SIGNUP_HOOK_SECRET"), net.DefaultResolver.LookupMX))
	// commit 是 Render 注入的 RENDER_GIT_COMMIT（本機為空字串）：deploy-pages.yml 的 deploy-api
	// 輪詢到它等於這次的 SHA，才放行前端部署
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, r *http.Request) {
		jsonOK(w, map[string]any{"ok": true, "commit": os.Getenv("RENDER_GIT_COMMIT")})
	})
	api := http.NewServeMux()
	api.HandleFunc("POST /api/auth/validate-upgrade-email", func(w http.ResponseWriter, r *http.Request) {
		handleValidateUpgradeEmail(w, r, postgresGuestAuthStore{pool: pool}, net.DefaultResolver.LookupMX)
	})
	api.HandleFunc("POST /api/rooms/{id}/search", func(w http.ResponseWriter, r *http.Request) {
		handleSearch(w, r, pool, places, weather, &searchInFlight)
	})
	api.HandleFunc("POST /api/rooms/{id}/start-voting", func(w http.ResponseWriter, r *http.Request) {
		handleStartVoting(w, r, pool, weather)
	})
	api.HandleFunc("POST /api/rooms/{id}/edit-conditions", func(w http.ResponseWriter, r *http.Request) {
		handleEditConditions(w, r, pool)
	})
	api.HandleFunc("POST /api/rooms/{id}/vote", func(w http.ResponseWriter, r *http.Request) {
		handleVote(w, r, pool, weather)
	})
	api.HandleFunc("POST /api/rooms/{id}/draw", func(w http.ResponseWriter, r *http.Request) {
		handleDraw(w, r, pool, weather)
	})
	api.HandleFunc("POST /api/rooms/{id}/confirm", func(w http.ResponseWriter, r *http.Request) {
		handleConfirmDraw(w, r, pool, weather)
	})
	api.HandleFunc("POST /api/rooms/{id}/redraw", func(w http.ResponseWriter, r *http.Request) {
		handleRedraw(w, r, pool, weather)
	})
	api.HandleFunc("POST /api/rooms/{id}/location-vote", func(w http.ResponseWriter, r *http.Request) {
		handleLocationVote(w, r, pool)
	})
	api.HandleFunc("POST /api/rooms/{id}/location", func(w http.ResponseWriter, r *http.Request) {
		handleChooseLocation(w, r, pool)
	})
	api.HandleFunc("POST /api/rooms/{id}/shortlist-vote", func(w http.ResponseWriter, r *http.Request) {
		handleShortlistVote(w, r, pool)
	})
	api.HandleFunc("POST /api/rooms/{id}/pick", func(w http.ResponseWriter, r *http.Request) {
		handlePick(w, r, pool)
	})
	api.HandleFunc("POST /api/rooms/{id}/cancel-shortlist", func(w http.ResponseWriter, r *http.Request) {
		handleCancelShortlist(w, r, pool)
	})
	api.HandleFunc("POST /api/leave", func(w http.ResponseWriter, r *http.Request) {
		handleLeave(w, r, pool, weather)
	})
	mux.Handle("/api/", v.Middleware(rateLimit(rl, api)))
	return cors(mux)
}

// loadWeather：天氣是加分資料，失敗不阻斷（比 Places 降級更輕：連橫幅都不用）
func loadWeather(ctx context.Context, wp WeatherProvider, lat, lng float64, at time.Time) *Weather {
	w, err := wp.Current(ctx, lat, lng, at)
	if err != nil {
		if ctx.Err() != nil {
			return nil // 請求已結束（搜尋提早回錯會取消並行中的天氣）：不是天氣故障，也沒有要評分
		}
		var ue *url.Error
		if errors.As(err, &ue) {
			err = ue.Err
		}
		log.Printf("weather provider failed, scoring without weather: %v", err)
		return nil
	}
	return &w
}

// loadWeatherCached：vote 熱路徑版——只讀快取、永不發網路（eng review D6）。
// miss 就當無資料（中性）；快取由前一次 search/draw 的 blocking fetch 餵飽。
func loadWeatherCached(wp WeatherProvider, lat, lng float64, at time.Time) *Weather {
	if w, ok := wp.CurrentCached(lat, lng, at); ok {
		return &w
	}
	return nil
}

func roomIDFromPath(w http.ResponseWriter, r *http.Request) (string, bool) {
	roomID := r.PathValue("id")
	var parsed pgtype.UUID
	if err := parsed.Scan(roomID); err != nil {
		jsonError(w, http.StatusNotFound, "找不到這場聚餐")
		return "", false
	}
	return roomID, true
}

// loadHostRoom 驗證房主身分並回房間；非房主回 403、找不到回 404、DB 故障回 500
func loadHostRoom(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) (RoomRow, bool) {
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return RoomRow{}, false
	}
	room, err := LoadRoom(r.Context(), pool, roomID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			jsonError(w, http.StatusNotFound, "找不到這場聚餐")
		} else {
			serverError(w, err, "資料庫錯誤，請稍後再試")
		}
		return room, false
	}
	if room.HostID != UserID(r) {
		jsonError(w, http.StatusForbidden, "只有發起人可以執行此操作")
		return room, false
	}
	return room, true
}

// ErrNotHost：host-gated 交易鎖內重驗失敗——呼叫者已非房主（退房繼任，ADR-0007）。
var ErrNotHost = errors.New("caller is no longer the room host")

// assertHostInTx：取得（或沿用）rooms row lock 後重驗 host_id；呼叫端後續 room transition
// 與 members lock 必須留在同一交易，保持 rooms → room_members 鎖序。
// loadHostRoom 的檢查在交易外，search 的 Places 呼叫是秒級窗口，
// 繼任（leaveOneRoom）可在其間 commit——比照 castVote 的成員重驗（ErrNotMember）。
func assertHostInTx(ctx context.Context, tx pgx.Tx, roomID, uid string) error {
	var hostID string
	if err := tx.QueryRow(ctx, `select host_id from rooms where id = $1 for update`, roomID).Scan(&hostID); err != nil {
		return roomRowErr(err)
	}
	if hostID != uid {
		return ErrNotHost
	}
	return nil
}

// ErrRoomNotFound：房間列本身已不存在（例如末位退房刪房）。只在讀取／鎖定房間列的地方
// 由 roomRowErr 轉出；draws 等其他列查無仍是 pgx.ErrNoRows，代表的是狀態已變，不是房間不見。
var ErrRoomNotFound = errors.New("room not found")

func roomRowErr(err error) error {
	if errors.Is(err, pgx.ErrNoRows) {
		return ErrRoomNotFound
	}
	return err
}

// writeError：房間動作共用的錯誤對映。conflictMsg 是各端點自己的 409 文案（使用者看得到，彼此不同）。
// 只經 pendingError、shortlistError 這類薄 wrapper 呼叫：500 的 log 位置取 wrapper 的呼叫端（Output 深度 3）。
func writeError(w http.ResponseWriter, err error, conflictMsg string) {
	switch {
	case errors.Is(err, ErrRoomNotFound):
		jsonError(w, http.StatusNotFound, "找不到這場聚餐")
	case errors.Is(err, ErrNotHost):
		jsonError(w, http.StatusForbidden, "只有發起人可以執行此操作")
	case errors.Is(err, ErrNotMember):
		jsonError(w, http.StatusForbidden, "你不是這場聚餐的成員")
	case errors.Is(err, ErrConflict), errors.Is(err, pgx.ErrNoRows):
		jsonError(w, http.StatusConflict, conflictMsg)
	default:
		serverErrorLog.Output(3, fmt.Sprint(err))
		jsonError(w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")
	}
}

// roomError：沒有自己 wrapper 的房間交易步驟用這個，conflictMsg 照該步驟原本的 409 文案傳入。
func roomError(w http.ResponseWriter, err error, conflictMsg string) {
	writeError(w, err, conflictMsg)
}

// loadMemberRoom：任一成員可用的操作（vote）用這個；房主限定仍走 loadHostRoom
func loadMemberRoom(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) (RoomRow, bool) {
	roomID, ok := roomIDFromPath(w, r)
	if !ok {
		return RoomRow{}, false
	}
	room, err := LoadRoom(r.Context(), pool, roomID)
	if err != nil {
		if errors.Is(err, pgx.ErrNoRows) {
			jsonError(w, http.StatusNotFound, "找不到這場聚餐")
		} else {
			serverError(w, err, "資料庫錯誤，請稍後再試")
		}
		return room, false
	}
	var isMember bool
	if err := pool.QueryRow(r.Context(),
		`select exists (select 1 from room_members where room_id = $1 and user_id = $2)`,
		room.ID, UserID(r)).Scan(&isMember); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return room, false
	}
	if !isMember {
		jsonError(w, http.StatusForbidden, "你不是這場聚餐的成員")
		return room, false
	}
	return room, true
}

func handleStartVoting(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, weather WeatherProvider) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	expectedSearchVersion := room.SearchVersion
	// 初選（ADR-0010）可選：從 candidates 或 shortlisting 開始投票；其他狀態走 candidates 讓 TransitionRoom 回 409
	from := room.Status
	if from != "shortlisting" {
		from = "candidates"
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	defer tx.Rollback(ctx)
	if err := TransitionRoom(ctx, tx, room.ID, from, "voting"); err != nil {
		roomError(w, err, "聚餐狀態已變更")
		return
	}
	if err := assertHostInTx(ctx, tx, room.ID, UserID(r)); err != nil {
		roomError(w, err, "聚餐狀態已變更")
		return
	}
	room, err = LoadRoom(ctx, tx, room.ID)
	if err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	if room.SearchVersion != expectedSearchVersion {
		jsonError(w, http.StatusConflict, "搜尋批次已更新")
		return
	}
	if from == "shortlisting" {
		if err := freezeShortlist(ctx, tx, room.ID); err != nil {
			shortlistError(w, err)
			return
		}
	}
	// Migration 20260905000300 hides legacy odds rather than fabricating an old draw. Restore
	// active candidates once, under the same room lock, before opening voting.
	var redacted bool
	if err := tx.QueryRow(ctx, `select exists (select 1 from room_candidates
		where room_id=$1 and status='kept' and probability is null)`, room.ID).Scan(&redacted); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	// 初選定案後也要重算：未圈選者轉成 shortlist 排除、kept 機率重新正規化
	if redacted || from == "shortlisting" {
		wx := loadWeatherCached(weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
		result, _, err := rescoreRoom(ctx, tx, room, wx)
		if err != nil {
			serverError(w, err, "重算失敗，請稍後再試")
			return
		}
		// 入圍店在圈選後全數打烊：不提交，交易回滾連同轉態與落選定案一起撤銷
		if from == "shortlisting" && len(result.Kept) == 0 {
			jsonError(w, http.StatusConflict, "入圍的店都已不在候選中（可能已打烊），請取消初選或修改條件")
			return
		}
	}
	if err := tx.Commit(ctx); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	jsonOK(w, map[string]string{"status": "voting"})
}

func handleEditConditions(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	// 初選中也可回準備；圈選與初選表決由 advance_room_search_version trigger 清掉
	from := room.Status
	if from != "shortlisting" {
		from = "candidates"
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	defer tx.Rollback(ctx)
	if err := TransitionRoom(ctx, tx, room.ID, from, "lobby"); err != nil {
		roomError(w, err, "聚餐狀態已變更")
		return
	}
	if err := assertHostInTx(ctx, tx, room.ID, UserID(r)); err != nil {
		roomError(w, err, "聚餐狀態已變更")
		return
	}
	if _, err := tx.Exec(ctx, `delete from room_candidates where room_id = $1`, room.ID); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	if _, err := tx.Exec(ctx, `update room_members set ready = false where room_id = $1`, room.ID); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// handleVote：spec §3（Task 0 修訂）— 投票/否決/收回的唯一入口（D15 領域命令）。
//
//	POST /vote {restaurant_id, kind: up|veto, op: cast|retract}
//	     │ 單一交易
//	     ▼
//	TransitionRoom(voting→voting) ─ 條件鎖：驗階段 + room row lock
//	     │                           （序列化同房投票；draw 後回 409 — D2 防線）
//	     ├─ castVote：候選驗證+互斥+限額+冪等（vote.go）
//	     └─ inline rescore（其餘資料 tx 內讀；pre-tx room 設定由 guard_room_columns 凍結）→ ReplaceCandidates → commit
func handleVote(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, weather WeatherProvider) {
	ctx := r.Context()
	room, ok := loadMemberRoom(w, r, pool)
	if !ok {
		return
	}
	expectedSearchVersion := room.SearchVersion
	var req VoteCommand
	r.Body = http.MaxBytesReader(w, r.Body, 1<<10)
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil ||
		(req.Kind != "up" && req.Kind != "veto") ||
		(req.Op != "cast" && req.Op != "retract") {
		jsonError(w, http.StatusBadRequest, "投票內容格式不正確")
		return
	}
	var restaurantID pgtype.UUID
	if err := restaurantID.Scan(req.RestaurantID); err != nil {
		jsonError(w, http.StatusUnprocessableEntity, "餐廳 ID 格式不正確")
		return
	}
	tx, err := pool.Begin(ctx)
	if err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	defer tx.Rollback(ctx)
	// 刻意的 no-op UPDATE：同時取得 rooms row lock 並檢查階段，勿最佳化移除。
	if err := TransitionRoom(ctx, tx, room.ID, "voting", "voting"); err != nil {
		roomError(w, err, "聚餐不在投票階段")
		return
	}
	room, err = LoadRoom(ctx, tx, room.ID)
	if err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	if room.SearchVersion != expectedSearchVersion {
		jsonError(w, http.StatusConflict, "搜尋批次已更新")
		return
	}
	wx := loadWeatherCached(weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
	uid := UserID(r)
	vetoesRemaining, err := castVote(ctx, tx, room.ID, uid, req)
	if err != nil {
		switch {
		// 僅在 loadMemberRoom 檢查後、投票交易取鎖前被退房的競態窗內可達；覆蓋率看不到，勿誤刪
		case errors.Is(err, ErrNotMember):
			jsonError(w, http.StatusForbidden, "你不是這場聚餐的成員")
		case errors.Is(err, ErrNotCandidate):
			jsonError(w, http.StatusUnprocessableEntity, "這家餐廳不在這場聚餐的候選名單中")
		case errors.Is(err, ErrVetoQuotaExceeded):
			jsonError(w, http.StatusConflict,
				fmt.Sprintf("否決額度已用完（每人在同一場聚餐最多 %d 個）", VetoQuota))
		default:
			serverError(w, err, "資料庫錯誤，請稍後再試")
		}
		return
	}
	// inline rescore（ADR-0003）：載入順序、baseline 與落盤細節見 rescoreRoom
	result, _, err := rescoreRoom(ctx, tx, room, wx)
	if err != nil {
		serverError(w, err, "重算失敗，請稍後再試")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	resp := resultJSON(result)
	resp["vetoes_remaining"] = vetoesRemaining
	jsonOK(w, resp)
}

type keptJSON struct {
	RestaurantID string       `json:"restaurant_id"`
	Name         string       `json:"name"`
	Probability  float64      `json:"probability"`
	Trace        []TraceEntry `json:"trace"`
}

type excludedJSON struct {
	Name   string   `json:"name"`
	Reason string   `json:"reason"`
	Kinds  []string `json:"kinds"`
}

// nonNilKinds 保證編碼端拿到 non-nil slice：DB 欄位 not null、JSON 出 [] 而非 null
func nonNilKinds(kinds []string) []string {
	if kinds == nil {
		return []string{}
	}
	return kinds
}

func resultJSON(result EngineResult) map[string]any {
	kept := []keptJSON{}
	for _, c := range result.Kept {
		kept = append(kept, keptJSON{c.Restaurant.ID, c.Name, c.Probability, c.Trace})
	}
	ex := []excludedJSON{}
	for _, e := range result.Excluded {
		ex = append(ex, excludedJSON{e.Name, e.Reason, nonNilKinds(e.Kinds)})
	}
	return map[string]any{"kept": kept, "excluded": ex}
}

func restaurantIDs(rs []Restaurant) []string {
	ids := make([]string, len(rs))
	for i, r := range rs {
		ids[i] = r.ID
	}
	return ids
}

func handleDraw(w http.ResponseWriter, r *http.Request, pool *pgxpool.Pool, weather WeatherProvider) {
	ctx := r.Context()
	room, ok := loadHostRoom(w, r, pool)
	if !ok {
		return
	}
	if room.Status != "voting" {
		jsonError(w, http.StatusConflict, "聚餐狀態不允許抽選")
		return
	}
	expectedSearchVersion := room.SearchVersion
	wx := loadWeather(ctx, weather, room.CenterLat, room.CenterLng, roomEvalTime(room))
	tx, err := pool.Begin(ctx)
	if err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	defer tx.Rollback(ctx)
	var version int64
	if err := tx.QueryRow(ctx, `update rooms set status='pending', draw_version=draw_version+1
		where id=$1 and status='voting' returning draw_version`, room.ID).Scan(&version); err != nil {
		roomError(w, err, "聚餐狀態已變更") // ErrNoRows：已不在 voting（或房間已刪），同屬 409
		return
	}
	if err := assertHostInTx(ctx, tx, room.ID, UserID(r)); err != nil {
		roomError(w, err, "聚餐狀態已變更")
		return
	}
	room, err = LoadRoom(ctx, tx, room.ID)
	if err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	if room.SearchVersion != expectedSearchVersion {
		jsonError(w, http.StatusConflict, "搜尋批次已更新")
		return
	}
	// spec §5.5：抽選前權威重算；細節見 rescoreRoom
	result, _, err := rescoreRoom(ctx, tx, room, wx)
	if err != nil {
		serverError(w, err, "重算失敗，請稍後再試")
		return
	}
	// 候選已由 rescoreRoom 落盤；此處所有早退都在 commit 前，deferred rollback 會撤回。
	// （持久化失敗時回 500 而非死路 409——寫入真的失敗了，500 才誠實。）
	if len(result.Kept) == 0 {
		for _, e := range result.Excluded {
			if hasKind(e.Kinds, "veto") {
				jsonError(w, http.StatusConflict, "候選已全數被否決，請成員收回否決後再抽選")
				return
			}
		}
		jsonError(w, http.StatusConflict, "候選已全數失效（可能都打烊了），請發起新的聚餐重新搜尋")
		return
	}
	winner, seed := Draw(result.Kept)
	probs := map[string]float64{}
	for _, c := range result.Kept {
		probs[c.Restaurant.ID] = c.Probability
	}
	if _, err := tx.Exec(ctx,
		`insert into draws (room_id, version, seed, winner_restaurant_id, probabilities)
		 values ($1, $2, $3, $4, $5)`, room.ID, version, seed, winner, probs); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	if err := tx.Commit(ctx); err != nil {
		serverError(w, err, "資料庫錯誤，請稍後再試")
		return
	}
	jsonOK(w, map[string]any{"winner_restaurant_id": winner, "seed": seed, "version": version})
}

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"runtime"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 不需要 DB：釘住房間動作錯誤對映的狀態碼與文案，以及 500 一定留下帶呼叫端位置的 log。
func TestRoomActionErrorMapping(t *testing.T) {
	var logs bytes.Buffer
	serverErrorLog.SetOutput(&logs)
	t.Cleanup(func() { serverErrorLog.SetOutput(os.Stderr) })
	checkBody := func(t *testing.T, w *httptest.ResponseRecorder, wantCode int, wantMsg string) {
		t.Helper()
		var body struct {
			Error string `json:"error"`
		}
		if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
			t.Fatalf("body %q: %v", w.Body.String(), err)
		}
		if w.Code != wantCode || body.Error != wantMsg {
			t.Fatalf("got %d %q, want %d %q", w.Code, body.Error, wantCode, wantMsg)
		}
	}
	// log 訊息 → 期望的呼叫端行號。比對到行號，Output 深度差一層就會落到別的檔或別的行。
	wantLogAt := map[string]int{}

	for _, tc := range []struct {
		name     string
		write    func(http.ResponseWriter, error)
		err      error
		wantCode int
		wantMsg  string
	}{
		{"room row gone", pendingError, ErrRoomNotFound, http.StatusNotFound, "找不到這場聚餐"},
		{"wrapped room row gone", shortlistError, fmt.Errorf("lock: %w", ErrRoomNotFound), http.StatusNotFound, "找不到這場聚餐"},
		{"not host", pendingError, ErrNotHost, http.StatusForbidden, "只有發起人可以執行此操作"},
		{"not member", shortlistError, ErrNotMember, http.StatusForbidden, "你不是這場聚餐的成員"},
		{"pending conflict", pendingError, ErrConflict, http.StatusConflict, "抽選結果已更新，請重新整理"},
		{"draw row missing stays 409", pendingError, pgx.ErrNoRows, http.StatusConflict, "抽選結果已更新，請重新整理"},
		{"shortlist conflict", shortlistError, ErrConflict, http.StatusConflict, "聚餐狀態已更新，請重新整理"},
		{"shortlist rejection keeps its text", shortlistError, shortlistRejected("目前不在初選階段"), http.StatusConflict, "目前不在初選階段"},
		{"pending db failure", pendingError, errors.New("pending boom"), http.StatusInternalServerError, "資料庫錯誤，請稍後再試"},
		{"shortlist db failure", shortlistError, errors.New("shortlist boom"), http.StatusInternalServerError, "資料庫錯誤，請稍後再試"},
		{"location conflict", locationError, ErrConflict, http.StatusConflict, "聚餐狀態已更新，請重新整理"},
		{"location db failure", locationError, errors.New("location boom"), http.StatusInternalServerError, "資料庫錯誤，請稍後再試"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			_, _, line, _ := runtime.Caller(0)
			tc.write(w, tc.err) // 必須緊接上一行：wrapper 的呼叫端就是 line+1
			if tc.wantCode == http.StatusInternalServerError {
				wantLogAt[tc.err.Error()] = line + 1
			}
			checkBody(t, w, tc.wantCode, tc.wantMsg)
		})
	}

	w := httptest.NewRecorder()
	_, _, line, _ := runtime.Caller(0)
	serverError(w, errors.New("direct boom"), "寫入餐廳快取失敗") // 必須緊接上一行：呼叫端就是 line+1
	wantLogAt["direct boom"] = line + 1
	checkBody(t, w, http.StatusInternalServerError, "寫入餐廳快取失敗")

	// roomError 多一個 conflictMsg 參數，塞不進上面的表：同樣緊接 Caller 直接呼叫
	w = httptest.NewRecorder()
	_, _, line, _ = runtime.Caller(0)
	roomError(w, errors.New("room boom"), "聚餐狀態已變更") // 必須緊接上一行：呼叫端就是 line+1
	wantLogAt["room boom"] = line + 1
	checkBody(t, w, http.StatusInternalServerError, "資料庫錯誤，請稍後再試")

	// 每個 500 都要記下原因，且位置是呼叫 mapper／serverError 的那一行，不是 helper 自己。
	for msg, line := range wantLogAt {
		if want := fmt.Sprintf("server_error_test.go:%d: %s", line, msg); !strings.Contains(logs.String(), want) {
			t.Fatalf("log 要含 %q，got：%s", want, logs.String())
		}
	}
	// 非 500 不記 log：409／403／404 是預期中的業務結果。
	if n := strings.Count(strings.TrimSpace(logs.String()), "\n") + 1; len(wantLogAt) != 5 || n != 5 {
		t.Fatalf("只有 5 個 500 該留 log，got %d 個期望、%d 行：%s", len(wantLogAt), n, logs.String())
	}
}

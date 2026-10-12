package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"

	"github.com/jackc/pgx/v5"
)

// 不需要 DB：釘住房間動作錯誤對映的狀態碼與文案，以及 500 一定留下帶呼叫端位置的 log。
func TestRoomActionErrorMapping(t *testing.T) {
	var logs bytes.Buffer
	serverErrorLog.SetOutput(&logs)
	t.Cleanup(func() { serverErrorLog.SetOutput(os.Stderr) })

	for _, tc := range []struct {
		name     string
		write    func(http.ResponseWriter, error)
		err      error
		wantCode int
		wantMsg  string
	}{
		{"room row gone", pendingError, ErrRoomNotFound, http.StatusNotFound, "房間不存在"},
		{"wrapped room row gone", shortlistError, fmt.Errorf("lock: %w", ErrRoomNotFound), http.StatusNotFound, "房間不存在"},
		{"not host", pendingError, ErrNotHost, http.StatusForbidden, "只有房主可以執行此操作"},
		{"not member", shortlistError, ErrNotMember, http.StatusForbidden, "你不是這個房間的成員"},
		{"pending conflict", pendingError, ErrConflict, http.StatusConflict, "抽選結果已更新，請重新整理"},
		{"draw row missing stays 409", pendingError, pgx.ErrNoRows, http.StatusConflict, "抽選結果已更新，請重新整理"},
		{"shortlist conflict", shortlistError, ErrConflict, http.StatusConflict, "房間狀態已更新，請重新整理"},
		{"shortlist rejection keeps its text", shortlistError, shortlistRejected("目前不在初選階段"), http.StatusConflict, "目前不在初選階段"},
		{"pending db failure", pendingError, errors.New("pending boom"), http.StatusInternalServerError, "資料庫錯誤，請稍後再試"},
		{"shortlist db failure", shortlistError, errors.New("shortlist boom"), http.StatusInternalServerError, "資料庫錯誤，請稍後再試"},
		{"direct server error", func(w http.ResponseWriter, err error) { serverError(w, err, "寫入餐廳快取失敗") },
			errors.New("direct boom"), http.StatusInternalServerError, "寫入餐廳快取失敗"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			w := httptest.NewRecorder()
			tc.write(w, tc.err)
			var body struct {
				Error string `json:"error"`
			}
			if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
				t.Fatalf("body %q: %v", w.Body.String(), err)
			}
			if w.Code != tc.wantCode || body.Error != tc.wantMsg {
				t.Fatalf("got %d %q, want %d %q", w.Code, body.Error, tc.wantCode, tc.wantMsg)
			}
		})
	}
	// 每個 500 都要記下原因，且位置指向呼叫 mapper／serverError 的那一行（這裡是本測試檔），不是 helper 自己。
	for _, want := range []string{"pending boom", "shortlist boom", "direct boom"} {
		line := ""
		for _, l := range strings.Split(logs.String(), "\n") {
			if strings.Contains(l, want) {
				line = l
			}
		}
		if !strings.Contains(line, "server_error_test.go:") {
			t.Fatalf("%q 的 log 要帶呼叫端位置，got %q（全部 log：%s）", want, line, logs.String())
		}
	}
	// 非 500 不記 log：409／403／404 是預期中的業務結果。
	if n := strings.Count(strings.TrimSpace(logs.String()), "\n") + 1; n != 3 {
		t.Fatalf("只有 3 個 500 該留 log，got %d 行：%s", n, logs.String())
	}
}

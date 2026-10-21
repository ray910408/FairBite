package main

import (
	"context"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"regexp"
	"strconv"
	"strings"
	"testing"
)

// 升級驗證端點回的每個錯誤碼都要在 web authErrors.ts 的 SERVER_MESSAGES 有中文對映，
// 否則使用者一律只看到「操作失敗」。兩邊都從原始碼推導：handler 的 jsonError 字面值
// ＋checkSignupEmail 的回傳值（handler 原樣轉出）對 SERVER_MESSAGES 的 key，不手抄碼表。
func TestGuestUpgradeErrorCodesHaveWebMessages(t *testing.T) {
	fset := token.NewFileSet()
	// fail closed：碼抽成 const／變數就推導不到，直接失敗，不能靜默漏收
	literal := func(e ast.Expr) string {
		lit, ok := e.(*ast.BasicLit)
		if !ok || lit.Kind != token.STRING {
			t.Fatalf("%s：錯誤碼不是字串字面值，本測試推導不到——改回字面值或同步本測試", fset.Position(e.Pos()))
		}
		s, _ := strconv.Unquote(lit.Value)
		return s
	}
	codesIn := func(file, fn string, match func(ast.Node) string) []string {
		t.Helper()
		f, err := parser.ParseFile(fset, file, nil, 0)
		if err != nil {
			t.Fatal(err)
		}
		var codes []string
		for _, d := range f.Decls {
			if fd, ok := d.(*ast.FuncDecl); ok && fd.Name.Name == fn {
				ast.Inspect(fd, func(n ast.Node) bool {
					if code := match(n); code != "" {
						codes = append(codes, code)
					}
					return true
				})
			}
		}
		if len(codes) == 0 {
			t.Fatalf("%s 的 %s 推導不出任何錯誤碼——改名或改寫了請同步本測試", file, fn)
		}
		return codes
	}
	forwarded := map[string]bool{} // handler 裡接 checkSignupEmail 回傳值、原樣轉出的變數
	codes := append(
		codesIn("guest_auth.go", "handleValidateUpgradeEmail", func(n ast.Node) string {
			switch n := n.(type) {
			case *ast.AssignStmt:
				if len(n.Lhs) == 1 && len(n.Rhs) == 1 {
					lhs, isIdent := n.Lhs[0].(*ast.Ident)
					if call, ok := n.Rhs[0].(*ast.CallExpr); ok && isIdent {
						if fn, ok := call.Fun.(*ast.Ident); ok && fn.Name == "checkSignupEmail" {
							forwarded[lhs.Name] = true
						}
					}
				}
			case *ast.CallExpr:
				if fn, ok := n.Fun.(*ast.Ident); ok && fn.Name == "jsonError" && len(n.Args) == 3 {
					// 唯一放行的非字面值：轉出 checkSignupEmail 的回傳值，它的碼由下面那組推導
					if id, ok := n.Args[2].(*ast.Ident); ok && forwarded[id.Name] {
						return ""
					}
					return literal(n.Args[2])
				}
			}
			return ""
		}),
		codesIn("signup_email.go", "checkSignupEmail", func(n ast.Node) string {
			if ret, ok := n.(*ast.ReturnStmt); ok && len(ret.Results) == 1 {
				return literal(ret.Results[0]) // `return ""` 是通過，literal 回 "" 不收
			}
			return ""
		})...)

	src, err := os.ReadFile("../web/src/lib/authErrors.ts")
	if err != nil {
		t.Fatalf("讀 authErrors.ts 失敗（測試依賴 repo 佈局 server/ ↔ web/）：%v", err)
	}
	block := regexp.MustCompile(`(?s)const SERVER_MESSAGES[^=]*=\s*\{(.*?)\n\}`).FindSubmatch(src)
	if block == nil {
		t.Fatal("authErrors.ts 找不到 SERVER_MESSAGES 區塊——改名了請同步本測試")
	}
	web := map[string]bool{}
	for _, m := range regexp.MustCompile(`(?m)^\s*([a-z_]+):`).FindAllSubmatch(block[1], -1) {
		web[string(m[1])] = true
	}
	for _, code := range codes {
		if !web[code] {
			t.Errorf("升級驗證會回錯誤碼 %q，但 authErrors.ts 的 SERVER_MESSAGES 沒有對映——使用者只會看到「操作失敗」，補 web 對照表", code)
		}
	}
}

type fakeGuestAuthStore struct {
	saveErr error
	saveOK  bool
	uid     string
	email   string
}

func (s *fakeGuestAuthStore) SaveValidation(_ context.Context, uid, email string) (bool, error) {
	s.uid, s.email = uid, email
	return s.saveOK, s.saveErr
}

func guestUpgradeRequest(body string) *http.Request {
	r := httptest.NewRequest(http.MethodPost, "/api/auth/validate-upgrade-email", strings.NewReader(body))
	return r.WithContext(context.WithValue(r.Context(), userIDKey, "guest-1"))
}

func TestValidateUpgradeEmail(t *testing.T) {
	mx := func(context.Context, string) ([]*net.MX, error) { return []*net.MX{{Host: "mail.example."}}, nil }
	t.Run("stores canonical exact email for current anonymous user", func(t *testing.T) {
		store := &fakeGuestAuthStore{saveOK: true}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":" Guest@GMAIL.COM "}`), store, mx)
		if w.Code != http.StatusOK || store.uid != "guest-1" || store.email != "guest@gmail.com" {
			t.Fatalf("status=%d uid=%q email=%q body=%s", w.Code, store.uid, store.email, w.Body.String())
		}
	})
	t.Run("rejects identity that the atomic store finds ineligible", func(t *testing.T) {
		store := &fakeGuestAuthStore{}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusConflict || store.email != "guest@gmail.com" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("keeps MX policy on upgrades", func(t *testing.T) {
		store := &fakeGuestAuthStore{saveOK: true}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@example.com"}`), store,
			func(context.Context, string) ([]*net.MX, error) { return nil, nil })
		if w.Code != http.StatusUnprocessableEntity || store.email != "" {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("does not grant on database failure", func(t *testing.T) {
		store := &fakeGuestAuthStore{saveErr: errors.New("down")}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusServiceUnavailable {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
	t.Run("rejects when account changes during validation", func(t *testing.T) {
		store := &fakeGuestAuthStore{}
		w := httptest.NewRecorder()
		handleValidateUpgradeEmail(w, guestUpgradeRequest(`{"email":"guest@gmail.com"}`), store, mx)
		if w.Code != http.StatusConflict {
			t.Fatalf("status=%d body=%s", w.Code, w.Body.String())
		}
	})
}

func TestPostgresGuestAuthStoreEligibility(t *testing.T) {
	pool, ctx := leaveTestPool(t)
	const validatedID = "75400000-0000-4000-8000-000000000001"
	const pendingID = "75400000-0000-4000-8000-000000000002"
	const confirmedID = "75400000-0000-4000-8000-000000000003"
	const permanentID = "75400000-0000-4000-8000-000000000004"
	ids := []string{validatedID, pendingID, confirmedID, permanentID}
	if _, err := pool.Exec(ctx, `delete from auth.users where id = any($1::uuid[])`, ids); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = pool.Exec(context.Background(), `delete from auth.users where id = any($1::uuid[])`, ids)
	})
	if _, err := pool.Exec(ctx, `insert into auth.users(id,email,is_anonymous) values
		($1,null,false), ($2,null,false), ($3,'confirmed@example.org',false), ($4,'member@example.org',false)`,
		validatedID, pendingID, confirmedID, permanentID); err != nil {
		t.Fatal(err)
	}
	if _, err := pool.Exec(ctx, `insert into public.guest_email_validations(user_id,email,phase,expires_at) values
		($1,'retry@example.org','validated',now()+interval '10 minutes'),
		($2,'pending@example.org','pending_confirmation',now()+interval '10 minutes'),
		($3,'confirmed@example.org','confirmed',now()+interval '10 minutes')`, validatedID, pendingID, confirmedID); err != nil {
		t.Fatal(err)
	}

	store := postgresGuestAuthStore{pool: pool}
	if saved, err := store.SaveValidation(ctx, validatedID, "retry@example.org"); err != nil || !saved {
		t.Fatalf("validated retry saved=%v err=%v", saved, err)
	}
	if saved, err := store.SaveValidation(ctx, pendingID, "pending@example.org"); err != nil || !saved {
		t.Fatalf("same-email pending retry saved=%v err=%v", saved, err)
	}
	var phase, email string
	if err := pool.QueryRow(ctx, `select phase,email from public.guest_email_validations where user_id=$1`, pendingID).Scan(&phase, &email); err != nil || phase != "pending_confirmation" || email != "pending@example.org" {
		t.Fatalf("same-email pending phase=%q email=%q err=%v", phase, email, err)
	}
	if saved, err := store.SaveValidation(ctx, pendingID, "corrected@example.org"); err != nil || !saved {
		t.Fatalf("corrected pending saved=%v err=%v", saved, err)
	}
	if err := pool.QueryRow(ctx, `select phase,email from public.guest_email_validations where user_id=$1`, pendingID).Scan(&phase, &email); err != nil || phase != "validated" || email != "corrected@example.org" {
		t.Fatalf("corrected pending phase=%q email=%q err=%v", phase, email, err)
	}
	for _, tc := range []struct{ name, uid string }{{"confirmed", confirmedID}, {"permanent", permanentID}} {
		t.Run(tc.name, func(t *testing.T) {
			if saved, err := store.SaveValidation(ctx, tc.uid, "other@example.org"); err != nil || saved {
				t.Fatalf("saved=%v err=%v", saved, err)
			}
		})
	}
}

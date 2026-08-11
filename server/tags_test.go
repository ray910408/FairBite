package main

// arch c7：tag 詞彙紀律測試——CUISINE_OPTIONS/DIETARY_OPTIONS 是使用者可選的詞彙，
// 但詞彙的生產者是 provider adapter（places_google.go googleTypeTags、mockdata.go）。
// 本測試釘住兩件事：(a) 地板——絕不提供沒有任何 adapter 產得出來的選項；
// (b) Google adapter 的已知缺口清單——只能刻意縮小，不能默默擴大（weights.go:69 的紀律）。
// 不需要 DB。

import (
	"os"
	"reflect"
	"regexp"
	"sort"
	"testing"
)

// webOptionKeys 讀 web 端 labels.ts 並以 regex 抽出指定 OPTIONS 常數的 key
// （元素形如 ['japanese', '日式']）。路徑相對 server/，依賴 repo 的 server/ ↔ web/ 佈局。
func webOptionKeys(t *testing.T, constName string) []string {
	t.Helper()
	src, err := os.ReadFile("../web/src/lib/labels.ts")
	if err != nil {
		t.Fatalf("讀 labels.ts 失敗（測試依賴 repo 佈局 server/ ↔ web/）：%v", err)
	}
	block := regexp.MustCompile(`(?s)` + constName + `[^=]*=\s*\[(.*?)\n\]`).FindSubmatch(src)
	if block == nil {
		t.Fatalf("labels.ts 找不到 %s 區塊——格式變了請同步本測試的 regex", constName)
	}
	var keys []string
	for _, m := range regexp.MustCompile(`\['([a-z_]+)'`).FindAllSubmatch(block[1], -1) {
		keys = append(keys, string(m[1]))
	}
	if len(keys) == 0 {
		t.Fatalf("%s 抽不出任何 key——格式變了請同步本測試的 regex", constName)
	}
	return keys
}

// googleProducibleTags 走真實的 gTags 對映（含 servesVegetarianFood 路徑），
// 不複製對映表——表變測試就跟著變。
func googleProducibleTags() map[string]bool {
	out := map[string]bool{}
	for gt := range googleTypeTags {
		for _, tag := range gTags(gPlace{Types: []string{gt}}) {
			out[tag] = true
		}
	}
	for _, tag := range gTags(gPlace{ServesVegetarianFood: true}) {
		out[tag] = true
	}
	return out
}

// mockProducibleTags 收集 mockdata.go 實際宣告的 tag 字面集合。
func mockProducibleTags() map[string]bool {
	out := map[string]bool{}
	for _, r := range mockRestaurants {
		for _, tag := range r.CuisineTags {
			out[tag] = true
		}
	}
	return out
}

// 地板：每個 CUISINE_OPTIONS key 至少要有一個 adapter 產得出來——
// 提供永遠選不到結果的選項，會靜默拖累該成員的滿足度 EMA（永無 pref hit）。
func TestCuisineOptionsProducibleByAtLeastOneAdapter(t *testing.T) {
	google, mock := googleProducibleTags(), mockProducibleTags()
	for _, key := range webOptionKeys(t, "CUISINE_OPTIONS") {
		if !google[key] && !mock[key] {
			t.Errorf("CUISINE_OPTIONS 的 %q 沒有任何 adapter 產得出來", key)
		}
	}
}

// Google 缺口釘住：缺口縮小時請同步把 key 自此清單移除；
// 缺口變大代表新增了 Google 產不出的選項，違反 weights.go:69 的紀律；
// 這三個選項的去留是產品決策，見 TODOS.md。
func TestCuisineOptionsGoogleGapIsPinned(t *testing.T) {
	wantGap := []string{"cantonese", "hotpot", "sichuan"}
	google := googleProducibleTags()
	var gap []string
	for _, key := range webOptionKeys(t, "CUISINE_OPTIONS") {
		if !google[key] {
			gap = append(gap, key)
		}
	}
	sort.Strings(gap)
	if !reflect.DeepEqual(gap, wantGap) {
		t.Errorf("CUISINE_OPTIONS 的 Google 缺口 = %v，want %v——缺口變動必須是刻意決策", gap, wantGap)
	}
}

// DIETARY_OPTIONS 與 tag 不是 1:1：只有 DietaryRequires 子集（vegetarian/halal）
// 要求餐廳具備正向認證 tag，才有「adapter 產得出來」的語意；
// no_beef/no_pork 是負向衝突排除，不需要任何 tag 被產出，故不在本檢查範圍。
func TestDietaryRequiredTagsCoverage(t *testing.T) {
	google, mock := googleProducibleTags(), mockProducibleTags()
	var googleGap []string
	for _, key := range webOptionKeys(t, "DIETARY_OPTIONS") {
		req, strict := DietaryRequires[key]
		if !strict {
			continue
		}
		if !google[req] && !mock[req] {
			t.Errorf("DIETARY_OPTIONS 的 %q 要求 tag %q，但沒有任何 adapter 產得出來", key, req)
		}
		if !google[req] {
			googleGap = append(googleGap, key)
		}
	}
	// halal→halal_certified 是已知 Google 缺口（places_google.go 檔頭已註明：無可靠清真
	// 認證訊號，清真成員在 Google provider 下會全排除）。釘住，只能刻意變動；
	// 去留是產品決策，見 TODOS.md。
	sort.Strings(googleGap)
	if !reflect.DeepEqual(googleGap, []string{"halal"}) {
		t.Errorf("DietaryRequires 的 Google 缺口 = %v，want [halal]——缺口變動必須是刻意決策", googleGap)
	}
}

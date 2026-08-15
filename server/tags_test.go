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
	// fail closed：另用寬鬆 regex 數 tuple 數（接受雙引號），與抽出的 key 數比對。
	// 少了這道，用雙引號或連字號寫的新選項會被靜默跳過，覆蓋檢查照樣全綠。
	tuples := regexp.MustCompile(`\[\s*['"]`).FindAllIndex(block[1], -1)
	if len(keys) == 0 || len(keys) != len(tuples) {
		t.Fatalf("%s 抽出 %d 個 key，但區塊內有 %d 個 tuple——格式變了請同步本測試的 regex",
			constName, len(keys), len(tuples))
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

func containsOption(options []string, want string) bool {
	for _, option := range options {
		if option == want {
			return true
		}
	}
	return false
}

func TestProductVocabularyIncludesFastFoodAndDessertWithoutHalal(t *testing.T) {
	cuisines := webOptionKeys(t, "CUISINE_OPTIONS")
	for _, want := range []string{"fast_food", "dessert"} {
		if !containsOption(cuisines, want) {
			t.Errorf("CUISINE_OPTIONS 必須包含 %q", want)
		}
	}
	if containsOption(webOptionKeys(t, "DIETARY_OPTIONS"), "halal") {
		t.Error("DIETARY_OPTIONS 不得再提供 Google 無可靠認證訊號的 halal")
	}
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

// Google 缺口已於 2026-08-13 清空：cantonese ← cantonese_restaurant + dim_sum_restaurant、
// hotpot ← hot_pot_restaurant（官方 Table A 查證），sichuan（無對應 type）自選單移除。
// 缺口變大代表新增了 Google 產不出的選項，違反 weights.go 的紀律。
func TestCuisineOptionsGoogleGapIsPinned(t *testing.T) {
	wantGap := []string{}
	google := googleProducibleTags()
	gap := []string{}
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

// Mock provider 是本機開發、demo 與 E2E 的預設路徑；每個料理選項都必須能實際命中。
// 預期缺口刻意釘為空集合，新增選項時不可再靜默漏掉對應的 mock tag。
func TestCuisineOptionsMockGapIsPinned(t *testing.T) {
	wantGap := []string{}
	mock := mockProducibleTags()
	gap := []string{}
	for _, key := range webOptionKeys(t, "CUISINE_OPTIONS") {
		if !mock[key] {
			gap = append(gap, key)
		}
	}
	sort.Strings(gap)
	if !reflect.DeepEqual(gap, wantGap) {
		t.Errorf("CUISINE_OPTIONS 的 mock 缺口 = %v，want %v；若是刻意缺口，請更新此測試並註明理由", gap, wantGap)
	}
}

func TestCuisineSearchQueriesCoverAllCuisineOptions(t *testing.T) {
	// codex #4 校正：該檔的 web key 清單取得方式是 webOptionKeys(t, "CUISINE_OPTIONS")（c7 既有 helper）
	for _, key := range webOptionKeys(t, "CUISINE_OPTIONS") {
		if _, ok := CuisineSearchQueries[key]; !ok {
			t.Errorf("菜系 %q 沒有 Text Search 查詢詞——定向檢索會對它靜默失效（fan-out 的 continue 分支）", key)
		}
	}
}

// DIETARY_OPTIONS 與 tag 不是 1:1：只有 DietaryRequires 子集（目前僅 vegetarian）
// 要求餐廳具備正向認證 tag，才有「adapter 產得出來」的語意；
// no_beef/no_pork 是負向衝突排除，不需要任何 tag 被產出，故不在本檢查範圍。
func TestDietaryRequiredTagsCoverage(t *testing.T) {
	google, mock := googleProducibleTags(), mockProducibleTags()
	googleGap := []string{}
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
	// 2026-08-12 產品決策移除清真：Google 無可靠認證訊號，保留選項只會讓所有結果被排除。
	// 因此 Google 缺口現在必須是空集合；日後新增 strict 選項仍需由 adapter 產出認證 tag。
	sort.Strings(googleGap)
	if !reflect.DeepEqual(googleGap, []string{}) {
		t.Errorf("DietaryRequires 的 Google 缺口 = %v，want []——缺口變動必須是刻意決策", googleGap)
	}
}

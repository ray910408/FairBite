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

// googleProducibleTags 走真實的 gTags 對映，
// 不複製對映表——表變測試就跟著變。
func googleProducibleTags() map[string]bool {
	out := map[string]bool{}
	for gt := range googleTypeTags {
		for _, tag := range gTags(gPlace{Types: []string{gt}}) {
			out[tag] = true
		}
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

// DIETARY_OPTIONS 只保留具正向 Places tag 證據的 DietaryRequires（目前僅 vegetarian）。
func TestDietaryRequiredTagsCoverage(t *testing.T) {
	google, mock := googleProducibleTags(), mockProducibleTags()
	googleGap := []string{}
	for _, key := range webOptionKeys(t, "DIETARY_OPTIONS") {
		req, strict := DietaryRequires[key]
		if !strict {
			t.Errorf("DIETARY_OPTIONS 的 %q 沒有正向 DietaryRequires 證據", key)
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

// observedGoogleTypes：2026-08-16 對台北四個點（台北車站／信義／東區忠孝復興／公館，
// 半徑 1500m）呼叫 Places API (New) searchNearby 與 13 個菜系 searchText 後，實際
// 出現在餐飲類結果裡的 Google type 普查。這份清單是快照不是真理——Google 會新增 type，
// 重跑普查後把新出現的補進來，讓測試繼續代表現實。
var observedGoogleTypes = []string{
	// 已對映
	"japanese_restaurant", "ramen_restaurant", "sushi_restaurant", "korean_restaurant",
	"chinese_restaurant", "cantonese_restaurant", "dim_sum_restaurant", "hot_pot_restaurant",
	"indian_restaurant", "seafood_restaurant", "steak_house", "american_restaurant",
	"italian_restaurant", "french_restaurant", "hamburger_restaurant", "fast_food_restaurant",
	"pizza_restaurant", "dessert_restaurant", "ice_cream_shop", "dessert_shop",
	"sandwich_shop", "salad_shop", "deli", "cafe", "coffee_shop",
	"breakfast_restaurant", "brunch_restaurant", "vegetarian_restaurant", "vegan_restaurant",
	// 本次普查新發現
	"taiwanese_restaurant", "western_restaurant", "european_restaurant",
	"japanese_izakaya_restaurant", "yakiniku_restaurant", "japanese_curry_restaurant",
	"noodle_shop", "chinese_noodle_restaurant", "asian_restaurant", "bistro",
	"dumpling_restaurant", "cafeteria", "buffet_restaurant", "chicken_restaurant",
	"chicken_wings_restaurant", "kebab_shop", "bar", "thai_restaurant",
	"malaysian_restaurant", "australian_restaurant", "hawaiian_restaurant",
	"pakistani_restaurant",
	"restaurant", "food", "point_of_interest", "establishment",
}

// 打標是 fail-open：沒列進 googleTypeTags 的 type 靜默產出 0 個 tag，沒有任何訊號會叫。
// 這道測試把它變成 fail-closed——比照 gIsMealPrimaryType 對 meal gate 的紀律
// （places_google.go:96）。不對映是合法選擇，但必須是寫下理由的選擇。
func TestObservedGoogleTypesAreMappedOrDeliberatelyUnmapped(t *testing.T) {
	for _, gt := range observedGoogleTypes {
		_, mapped := googleTypeTags[gt]
		reason, waived := googleTypesDeliberatelyUnmapped[gt]
		switch {
		case mapped && waived:
			t.Errorf("Google type %q 同時在 googleTypeTags 與刻意不對映清單裡——擇一", gt)
		case !mapped && !waived:
			t.Errorf("Google type %q 既未對映也未列入刻意不對映清單；"+
				"打標 fail-open，漏一個就靜默產 0 個 tag", gt)
		case waived && reason == "":
			t.Errorf("Google type %q 列在刻意不對映清單但沒寫理由", gt)
		}
	}
}

// knownTagVocabulary：已知 tag ＝ 有消費者的 tag。刻意從消費端推導而不是手抄清單——
// 手抄清單會同時祝福「產得出但沒人讀」與「有人讀但產不出」兩種孤兒，而那兩種孤兒
// 正是本輪根因的一體兩面（beef_noodle 是後者，sushi/curry 是前者）。
// 新增一個手抄白名單，就是在新增一個「誰也不用對帳」的地方。
func knownTagVocabulary(t *testing.T) map[string]bool {
	t.Helper()
	known := map[string]bool{}
	for _, key := range webOptionKeys(t, "CUISINE_OPTIONS") {
		known[key] = true
	}
	for _, req := range DietaryRequires {
		known[req] = true
	}
	return known
}

// 沒有豁免清單、沒有逃生門：想產一個沒人讀的 tag 就是不行。
// eng review T3（採納 outside voice）：原本設計了一張 unconsumedTags 登記表收容
// sushi/curry，但為兩個死字串蓋一整套登記機制，比直接不要產它們更複雜——而且
// 登記了不等於修了，它們還是會繼續寫進 prod DB。Step 5 直接移除那兩個 tag。
func TestGoogleTypeTagsProduceOnlyKnownVocabulary(t *testing.T) {
	known := knownTagVocabulary(t)
	for gt, tags := range googleTypeTags {
		for _, tag := range tags {
			if !known[tag] {
				t.Errorf("googleTypeTags[%q] 產出 %q，但沒有任何消費端會讀它——"+
					"不是打錯字，就是這個 tag 不該存在", gt, tag)
			}
		}
	}
}

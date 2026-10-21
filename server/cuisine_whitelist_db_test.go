package main

import (
	"context"
	"regexp"
	"slices"
	"testing"
	"time"
)

// labels.ts 的 CUISINE_OPTIONS 與 DB valid_member_cuisines 的白名單（migration 手寫陣列）對帳。
// web↔Go 由 tags_test.go 對帳；這裡補 web↔DB。兩邊都從活的來源推導：web 讀 labels.ts，
// DB 讀本機已套用的函式——不在測試裡抄第三份清單。
func TestCuisineOptionsMatchDBWhitelist(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	pool := newTestPool(t, ctx)
	web := webOptionKeys(t, "CUISINE_OPTIONS")

	// web → DB：選單上的選項 DB 不收，成員存條件會被 room_members_cuisines_bounds 擋下
	for _, key := range web {
		var ok bool
		if err := pool.QueryRow(ctx, `select public.valid_member_cuisines(jsonb_build_array($1::text))`, key).Scan(&ok); err != nil {
			t.Fatal(err)
		}
		if !ok {
			t.Errorf("labels.ts 的菜系 %q 被 DB valid_member_cuisines 拒絕——補一支 migration 把它加進白名單", key)
		}
	}

	// DB → web：從已套用的函式定義抽出白名單陣列
	var def string
	if err := pool.QueryRow(ctx,
		`select pg_get_functiondef(to_regprocedure('public.valid_member_cuisines(jsonb)'))`).Scan(&def); err != nil {
		t.Fatalf("讀 valid_member_cuisines 定義失敗（函式不存在或改了簽章）：%v", err)
	}
	list := regexp.MustCompile(`(?s)valid_member_choices\(j,\s*array\[(.*?)\]`).FindStringSubmatch(def)
	if list == nil {
		t.Fatalf("valid_member_cuisines 定義裡找不到 valid_member_choices(j, array[...])——函式改寫了請同步本測試：\n%s", def)
	}
	keys := regexp.MustCompile(`'([a-z_]+)'`).FindAllStringSubmatch(list[1], -1)
	// fail closed：字面值數要等於抽出的 key 數，否則格式外的值（連字號、大寫）會被靜默跳過
	if literals := regexp.MustCompile(`'[^']*'`).FindAllString(list[1], -1); len(keys) == 0 || len(keys) != len(literals) {
		t.Fatalf("白名單抽出 %d 個 key，但有 %d 個字面值——格式變了請同步本測試的 regex：%s", len(keys), len(literals), list[1])
	}
	for _, m := range keys {
		if !slices.Contains(web, m[1]) {
			t.Errorf("DB 白名單有 %q 但 labels.ts 的 CUISINE_OPTIONS 沒有——補 labels.ts 選項（或用 migration 從白名單移除）", m[1])
		}
	}
}

-- 移除快取中由 servesVegetarianFood 誤標的 vegetarian_friendly。
--
-- 為什麼：Google 的 servesVegetarianFood 表示「菜單有素食選項」，不是「素食餐廳」。
-- 2026-08-16 實測台北四點 70 家池子中 25 家（36%）為 true 但 types 無 vegetarian/vegan，
-- 含雙月食品社（雞湯）、鼎泰豐、吉星港式飲茶。vegetarian 是 DietaryRequires 的嚴格禁忌
-- （engine.go hardExclude），這些列會讓素食成員的硬性條件被誤放行。程式端已於同一次
-- 變更移除該來源，但 restaurants 快取的 TTL 是 30 天，不清理就要等一個月才自癒。
--
-- 這份清理刻意是不完整的（同 0016／0018 的限制）：cuisine_tags 由完整 types 陣列導出，
-- 而我們只持久化 primary_type（0014）。「primaryType 是 restaurant、types 含
-- vegetarian_restaurant」這類真素食店會被誤刪標籤，下一次成功 fetch 由 UpsertRestaurants
-- 自癒。方向是刻意的：素食是硬性條件，寧可漏放行也不可誤放行（ADR-0001、weights.go:33）。
--
-- primary_type 為 NULL 必須被清（eng review，outside voice #3）：0014 的檔頭寫明
-- 「既有列刻意維持 NULL，由 Go 端 fail-closed」，而 SQL 的 `NULL not in (...)` 求值為
-- NULL 不是 TRUE——直接寫 `primary_type not in (...)` 會讓所有 0014 之前寫入的列
-- 全數躲過清理，而且驗證 query 若複製同一個寫法會回 0，看起來乾淨。用 coalesce 蓋掉。
--
-- 只清 source = 'google'（PR #18 codex review）：誤標出自 Google adapter 的 gTags，
-- mock provider 的列是從 mockdata.go 的人工策展資料逐字寫入的，不可能帶這個缺陷。
-- 清掉它們只會毀掉策展事實（例：復興清粥小菜的 vegetarian_friendly），而那些列要等到
-- 下次 mock 搜尋才自癒，期間歷史紀錄與偏好學習讀到的是被削過的 tag。用正面表列而非
-- `<> 'mock'`：第三個 provider 進來時「不是 mock」不等於「是 google」（db.go:311 同款理由）。
--
-- 冪等：jsonb 的 `-` 運算子對不存在的元素是 no-op，重跑安全。這點在本輪很重要——
-- Go server（Render）與 migration（GitHub Actions）的部署先後沒有定義，若 migration
-- 先跑而舊 binary 還在服務，tag 會被寫回去，屆時重跑本檔即可。
-- 下面這段 UPDATE 與 supabase/tests/rls_test.sql 末段逐字相同（migration 只跑一次，測試
-- 無從重放，只能複製同一段邏輯）；改這裡就要一起改那裡。
update public.restaurants
set cuisine_tags = cuisine_tags - 'vegetarian_friendly'
where cuisine_tags @> '["vegetarian_friendly"]'::jsonb
  and source = 'google'
  and coalesce(primary_type, '') not in ('vegetarian_restaurant', 'vegan_restaurant');

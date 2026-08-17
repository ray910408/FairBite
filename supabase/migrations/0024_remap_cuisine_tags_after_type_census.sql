-- 2026-08-16 Google type 普查後的快取對映對帳：先清掉被收回的推定，再回填新增的對映。
--
-- 為什麼需要：cuisine_tags 是寫入當下由 googleTypeTags 導出的快照，restaurants 的 TTL 是
-- 30 天，而 LoadCachedRestaurants 在 provider 掛掉時會原樣端出這些舊列（cuisine_tags 不會
-- 重算，只有下一次成功 fetch 的 UpsertRestaurants 會覆蓋）。對映改了卻不清快取，降級模式
-- 就會繼續重現這次要修的兩個症狀，直到每一列各自被刷新或過期。0016／0018 是同一個處理。
--
-- 一、收回 chinese_restaurant → taiwanese 的推定。
-- 2026-08-16 實測 259 家樣本中 165 家帶 chinese_restaurant：僅 15% 確認台菜、14% 是被誤標成
-- 台式的港式店（玖龍冰室、富宴精緻粵菜港式飲茶）、72% 無從分辨。本批變更前
-- taiwanese_restaurant 尚未對映，因此快取裡每一個 taiwanese 都出自 chinese_restaurant 這條
-- 已被刪除的推定——清掉是精確的，不是保守估計。primary_type 已經是 taiwanese_restaurant 的
-- 列除外：那是新對映下依然成立的證據。
--
-- 二、回填本批新增的六條對映（taiwanese／western／japanese）。
-- 這六種 primaryType 都以 _restaurant 結尾，一直通過 gIsMealPrimaryType，快取裡早有這些列。
--
-- 兩份都刻意是不完整的（0016／0018／0023 的同款限制）：cuisine_tags 由完整 types 陣列導出，
-- 而我們只持久化 primary_type（0014）。「primaryType 是 restaurant、types 含
-- taiwanese_restaurant」這類列，清理會誤刪、回填也補不到——下一次成功 fetch 由
-- UpsertRestaurants 自癒。方向可接受：菜系少一個 tag 是漏，不是誤放行（ADR-0001）。
--
-- primary_type 為 NULL 必須被清（同 0023）：0014 的檔頭寫明「既有列刻意維持 NULL」，而 SQL
-- 的 `NULL <> '...'` 求值為 NULL 不是 TRUE——直接比對會讓 0014 之前寫入的列全數躲過清理。
-- 用 coalesce 蓋掉。
--
-- 只有清理限定 source = 'google'，回填不限定（PR #18 codex review）。這個不對稱是刻意的：
-- 被收回的推定出自 Google adapter 的 gTags，mock provider 的列是從 mockdata.go 的人工策展
-- 資料逐字寫入的，不可能帶這個缺陷——阿宗麵線與林東芳牛肉麵的 primary_type 正是
-- noodle_shop，不限定 source 就會把剛還原的策展事實再刪一次。回填則相反：把正確的 tag
-- 加給 primary_type 對得上的列，不論出身都是對的，也與 0016／0018 的既有形狀一致。
-- 用正面表列而非 `<> 'mock'`：第三個 provider 進來時「不是 mock」不等於「是 google」。
--
-- 冪等：`-` 對不存在的元素是 no-op；回填有 not @> 前綴條件，重跑不會產生重複元素。
-- 順序無關：清理排除 taiwanese_restaurant，回填只加給 taiwanese_restaurant，兩段不重疊。
-- 下面四段 UPDATE 與 supabase/tests/rls_test.sql 末段逐字相同（migration 只在套用時跑一次，
-- 測試無從重放，只能複製同一段邏輯）；改這裡就要一起改那裡。
update public.restaurants
set cuisine_tags = cuisine_tags - 'taiwanese'
where cuisine_tags @> '["taiwanese"]'::jsonb
  and source = 'google'
  and coalesce(primary_type, '') <> 'taiwanese_restaurant';

update public.restaurants
set cuisine_tags = cuisine_tags || '["taiwanese"]'::jsonb
where primary_type = 'taiwanese_restaurant'
  and not cuisine_tags @> '["taiwanese"]'::jsonb;

update public.restaurants
set cuisine_tags = cuisine_tags || '["western"]'::jsonb
where primary_type in ('western_restaurant', 'european_restaurant')
  and not cuisine_tags @> '["western"]'::jsonb;

update public.restaurants
set cuisine_tags = cuisine_tags || '["japanese"]'::jsonb
where primary_type in ('japanese_izakaya_restaurant', 'yakiniku_restaurant', 'japanese_curry_restaurant')
  and not cuisine_tags @> '["japanese"]'::jsonb;

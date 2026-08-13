-- 回填既有快取列的 cuisine_tags：cantonese_restaurant / dim_sum_restaurant → cantonese、
-- dim_sum_restaurant → dimsum（供 no_pork 硬排除比對）、
-- hot_pot_restaurant → hotpot。
--
-- 為什麼需要：這三種 primaryType 一直通過 gIsMealPrimaryType（_restaurant 後綴），快取裡
-- 早就有這些列；但 googleTypeTags 是 2026-08-13 才補上映射，先前寫下的列 cuisine_tags
-- 不含新標籤。provider 掛掉時 LoadCachedRestaurants 會端出 30 天內的舊列，勾「港式」「火鍋」
-- 的成員拿不到偏好加成，要等下一次成功的 provider refresh 自癒。
--
-- 這份回填刻意是不完整的（0016 同款限制）：cuisine_tags 原本從完整 types 陣列導出，而我們
-- 只持久化了 primary_type（0014）。「primaryType 是 restaurant、types 含 hot_pot_restaurant」
-- 這類列補不到——下一次成功 fetch 由 UpsertRestaurants 自癒。
--
-- 冪等：只在尚未含該標籤時才串接。
-- 下面三段 UPDATE 與 supabase/tests/rls_test.sql 末段逐字相同（migration 只跑一次，測試
-- 無從重放，只能複製同一段邏輯）；改這裡就要一起改那裡。
update public.restaurants
set cuisine_tags = cuisine_tags || '["cantonese"]'::jsonb
where primary_type in ('cantonese_restaurant', 'dim_sum_restaurant')
  and not cuisine_tags @> '["cantonese"]'::jsonb;

update public.restaurants
set cuisine_tags = cuisine_tags || '["dimsum"]'::jsonb
where primary_type = 'dim_sum_restaurant'
  and not cuisine_tags @> '["dimsum"]'::jsonb;

update public.restaurants
set cuisine_tags = cuisine_tags || '["hotpot"]'::jsonb
where primary_type = 'hot_pot_restaurant'
  and not cuisine_tags @> '["hotpot"]'::jsonb;

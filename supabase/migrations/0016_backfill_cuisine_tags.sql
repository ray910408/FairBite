-- 回填既有快取列的 cuisine_tags：sandwich_shop / salad_shop / deli → light_meal、
-- brunch_restaurant → breakfast。
--
-- 為什麼需要：這四種 primaryType 在本 PR 之前就已通過 gIsMealPrimaryType（前三者列在
-- googleMealPrimaryTypes，brunch_restaurant 吃 _restaurant 後綴），所以快取裡早就有這些列；
-- 但它們是本 PR 才被加進 googleTypeTags，先前寫下的列 cuisine_tags 不含新標籤。provider 掛掉
-- 時 LoadCachedRestaurants 會端出這些 30 天內的舊列，勾「輕食」或「早午餐」的成員因此拿不到
-- 偏好加成，要等下一次成功的 provider refresh 由 UpsertRestaurants 覆蓋才會自癒。
-- （cafe / coffee_shop 同樣是本 PR 才對映到 light_meal，但它們連 gIsMealPrimaryType 都是本 PR
-- 才通過，之前不可能被寫進快取，沒有列要回填。）
--
-- 這份回填刻意是不完整的：cuisine_tags 原本是從 Google 完整的 types 陣列導出，而我們只持久化
-- 了 primary_type（0014）。「primaryType 是 restaurant、但 types 裡含 cafe」這類列這裡補不到
-- ——那些會在下一次成功的 provider fetch 由 UpsertRestaurants 自癒。本專案尚無 production
-- 部署，這支主要是為了正確性與 dev/staging 的既有快取。
--
-- 冪等：只在尚未含該標籤時才串接，重跑不會產生重複元素。
-- 下面兩段 UPDATE 與 supabase/tests/rls_test.sql 末段逐字相同（migration 只在套用時跑一次，
-- 測試無從重放，只能複製同一段邏輯）；改這裡就要一起改那裡。
update public.restaurants
set cuisine_tags = cuisine_tags || '["light_meal"]'::jsonb
where primary_type in ('sandwich_shop', 'salad_shop', 'deli')
  and not cuisine_tags @> '["light_meal"]'::jsonb;

update public.restaurants
set cuisine_tags = cuisine_tags || '["breakfast"]'::jsonb
where primary_type = 'brunch_restaurant'
  and not cuisine_tags @> '["breakfast"]'::jsonb;

-- 自訂菜系（CONTEXT.md 料理偏好）：成員可在選單外自填一個菜系，存成 "custom:<文字>"。
-- 伺服器拿原文當 Places 定向檢索詞（weights.go cuisineSearchQueries），命中只以查詢命中生效；
-- 每個不同的詞都是一支付費檢索，所以上限在 DB 寫入邊界把關：每人至多 1 個、文字 1–10 字、
-- 前後無半形空白（btrim 只修 ASCII 空格；全形空白由前端 trim 處理）、無控制字元。
-- 預設選項的白名單與既有上限不變，舊資料是新規則的子集，驗證必過。
create function public.valid_member_cuisines(j jsonb)
returns boolean language plpgsql immutable set search_path = public as $$
declare
  customs text[];
begin
  if j is null or jsonb_typeof(j) <> 'array' then return false; end if;
  select coalesce(array_agg(e #>> '{}'), '{}') into customs
  from jsonb_array_elements(j) e
  where jsonb_typeof(e) = 'string' and starts_with(e #>> '{}', 'custom:');
  if cardinality(customs) > 1 or exists (
    select 1 from unnest(customs) c, lateral (select substr(c, char_length('custom:') + 1) as t) s
    where s.t <> btrim(s.t) or char_length(s.t) not between 1 and 10 or s.t ~ '[[:cntrl:]]'
  ) then return false; end if;
  -- 合格的自訂值併入白名單，型別、長度、去重、總數上限沿用既有 helper
  return public.valid_member_choices(j,
    array['taiwanese','japanese','korean','cantonese','western','fast_food','indian',
          'hotpot','seafood','ramen','dessert','light_meal','breakfast'] || customs, 20);
end $$;

alter table public.room_members
  drop constraint room_members_cuisines_bounds,
  add constraint room_members_cuisines_bounds check (public.valid_member_cuisines(cuisines));

-- Round 3（spec §5–§6）：菜系過濾開關＝房間層硬性條件（CONTEXT.md「菜系過濾」）；
-- 查詢命中（query match）＝房間層料理匹配證據，不改寫 restaurants 的 canonical tags（ADR-0006）。
alter table public.rooms add column cuisine_filter boolean not null default false;

-- 比照 0017 meal_time：欄級 UPDATE grant + rooms_update RLS（限房主列）+ guard 凍結；
-- 0015 的 SELECT 欄級 grant 是正面表列，新欄要自己加進去，否則前端讀不到。
grant update (cuisine_filter) on public.rooms to authenticated;
grant select (cuisine_filter) on public.rooms to authenticated;

-- 查詢命中隨候選列持久化（比照 0012 exclusion_kinds 的 text[] 先例；原生元素型別免 CHECK）。
-- room_candidates 對 authenticated 只有 SELECT（table-level），寫入走 service role，毋須新 grant。
alter table public.room_candidates add column query_matches text[] not null default '{}';

-- TODOS 結清（eng review TODO-1 裁定 C）：restaurants.cuisine_tags 補 D5 式元素型別 CHECK。
-- 複用 0010 的 jsonb_is_string_array（CHECK 不允許 subquery，helper 正是為此而生）；
-- 既有列全為 Go json.Marshal 產出的 array，直接上約束安全。
alter table public.restaurants
  add constraint restaurants_cuisine_tags_strings
  check (public.jsonb_is_string_array(cuisine_tags));

-- guard 擴充：cuisine_filter 僅能在 lobby 調整（照抄 0017 條款形狀，整支函式重建）。
create or replace function public.guard_room_columns()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then
    return new;
  end if;
  if new.status is distinct from old.status
     or new.code is distinct from old.code
     or new.host_id is distinct from old.host_id
     or new.center_lat is distinct from old.center_lat
     or new.center_lng is distinct from old.center_lng then
    raise exception '僅系統可修改房間狀態欄位';
  end if;
  if new.exploration is distinct from old.exploration and old.status <> 'lobby' then
    raise exception '探索檔位僅能在等待階段調整';
  end if;
  if new.meal_time is distinct from old.meal_time and old.status <> 'lobby' then
    raise exception '用餐時間僅能在等待階段調整';
  end if;
  if new.cuisine_filter is distinct from old.cuisine_filter and old.status <> 'lobby' then
    raise exception '菜系過濾僅能在等待階段調整';
  end if;
  return new;
end $$;

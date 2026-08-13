-- 用餐時間（spec §4）：NULL = 馬上出發。timestamptz 存絕對時刻，「今日限定」是
-- client 端 UX 約束（引擎以 max(now, meal_time) 容錯，繞過直寫者只影響自房結果），
-- 因此刻意不加日期 CHECK。
alter table public.rooms add column meal_time timestamptz;

-- 比照 exploration（0003）：欄級 UPDATE grant + rooms_update RLS（限房主列）+ guard 凍結。
grant update (meal_time) on public.rooms to authenticated;
-- 0015 的 SELECT 欄級 grant 是正面表列，新欄要自己加進去，否則前端讀不到。
grant select (meal_time) on public.rooms to authenticated;

-- guard 擴充：meal_time 僅能在 lobby 調整（照抄 0003 exploration 條款的形狀）。
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
  return new;
end $$;

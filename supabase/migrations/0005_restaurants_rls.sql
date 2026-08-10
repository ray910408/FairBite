-- 條件 UPDATE 的 RLS 必須先鎖 rooms，和搜尋凍結統一採 rooms → room_members 鎖序。
-- 只鎖 member row 不夠：等待中的 UPDATE 仍沿用原 statement snapshot 看見 lobby。
create or replace function public.is_room_lobby_locked(p_room_id uuid)
returns boolean language plpgsql volatile security definer set search_path = public as $$
declare v_status text;
begin
  if not is_room_member(p_room_id) then return false; end if;
  select status into v_status from rooms where id = p_room_id for update;
  return v_status = 'lobby';
end $$;

revoke execute on function public.is_room_lobby_locked from anon, public;
grant execute on function public.is_room_lobby_locked to authenticated;

drop policy members_update on public.room_members;
create policy members_update on public.room_members for update to authenticated
  using (user_id = auth.uid() and is_room_lobby_locked(room_id))
  with check (user_id = auth.uid() and is_room_lobby_locked(room_id));

-- 餐廳快取只對引用它的房間成員可見，避免 authenticated 枚舉其他房間的搜尋位置。
drop policy restaurants_select on public.restaurants;
create policy restaurants_select on public.restaurants for select to authenticated
  using (exists (
    select 1 from room_candidates rc
    where rc.restaurant_id = restaurants.id and is_room_member(rc.room_id)));

-- 保留 table-level SELECT grant 讓 RLS 篩列；Go/service role 具 BYPASSRLS，不受影響。

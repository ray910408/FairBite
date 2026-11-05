-- 發起聚餐可以先不帶出發點：進房後在準備階段由房主選（relocation.go handleChooseLocation 本來就收 lobby）。
-- 搜尋前一定要有出發點，由 Go handleSearch 擋；這裡只放寬建房入口。
-- 前端讀不到 center_*（0015 欄級 grant），用 has_location 判斷「還沒選地點」。
-- 同樣是欄級 grant，只露出「有沒有」，不露出座標本身。
alter table public.rooms
  add column has_location boolean not null generated always as (center_lat is not null and center_lng is not null) stored;
grant select (has_location) on public.rooms to authenticated;

-- 本體同 20261022000100_security_hardening.sql，只改座標檢查：兩個都 null 合法（之後再選），
-- 只給一個仍是無效座標。預設值讓前端可以整組不帶。
create or replace function public.create_room(p_lat double precision default null, p_lng double precision default null)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_uid uuid := auth.uid();
  v_room_id uuid;
  v_limits public.resource_quota_limits%rowtype;
  v_usage public.account_resource_usage%rowtype;
  v_now timestamptz;
  v_day date;
begin
  if v_uid is null then raise exception '未登入'; end if;
  if not public.is_registered_account(v_uid) then
    raise exception '訪客需完成註冊後才能建立房間' using errcode = 'P0001';
  end if;
  if (p_lat is null) <> (p_lng is null)
     or (p_lat is not null and not (p_lat between -90 and 90 and p_lng between -180 and 180)) then
    raise exception '無效的座標' using errcode = '22023';
  end if;
  select * into strict v_limits from public.resource_quota_limits where singleton for update;
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  insert into public.account_resource_usage (user_id) values (v_uid) on conflict do nothing;
  select * into strict v_usage from public.account_resource_usage where user_id = v_uid;
  if v_usage.room_window <= v_now - interval '10 minutes' then
    v_usage.room_window := v_now; v_usage.rooms_window := 0;
  end if;
  if v_usage.room_day <> v_day then v_usage.rooms_day := 0; end if;
  if v_usage.rooms_window >= v_limits.room_window_limit
     or v_usage.rooms_day >= v_limits.room_daily_limit
     or (select count(*) from public.rooms where host_id = v_uid and status <> 'decided'
         and (status <> 'lobby' or created_at > v_now - interval '24 hours')) >= v_limits.active_room_limit then
    raise exception '建房額度已用完，請稍後再試' using errcode = 'P0001';
  end if;
  update public.account_resource_usage set room_window = v_usage.room_window,
    rooms_window = v_usage.rooms_window + 1, room_day = v_day, rooms_day = v_usage.rooms_day + 1
    where user_id = v_uid;
  insert into public.rooms (host_id, center_lat, center_lng)
    values (v_uid, p_lat, p_lng) returning id into v_room_id;
  insert into public.room_members (room_id, user_id) values (v_room_id, v_uid);
  return v_room_id;
end $$;
revoke all on function public.create_room(double precision, double precision) from public, anon;
grant execute on function public.create_room(double precision, double precision) to authenticated;

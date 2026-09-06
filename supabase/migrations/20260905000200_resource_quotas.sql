-- Durable admission control shared by every API replica and direct create_room RPC.
-- Limits are operational knobs; only database administrators can change them.
create table public.resource_quota_limits (
  singleton boolean primary key default true check (singleton),
  room_window_limit integer not null default 5 check (room_window_limit >= 0),
  room_daily_limit integer not null default 20 check (room_daily_limit >= 0),
  active_room_limit integer not null default 5 check (active_room_limit >= 0),
  search_window_limit integer not null default 5 check (search_window_limit >= 0),
  search_daily_limit integer not null default 30 check (search_daily_limit >= 0),
  account_paid_daily_limit integer not null default 120 check (account_paid_daily_limit >= 0),
  global_paid_daily_limit integer not null default 10000 check (global_paid_daily_limit >= 0),
  concurrent_search_limit integer not null default 4 check (concurrent_search_limit >= 0),
  paid_day date not null default (now() at time zone 'UTC')::date,
  paid_used integer not null default 0 check (paid_used >= 0)
);
insert into public.resource_quota_limits (singleton) values (true);

create table public.account_resource_usage (
  user_id uuid primary key references auth.users(id) on delete cascade,
  room_window timestamptz not null default '-infinity',
  rooms_window integer not null default 0,
  room_day date not null default '-infinity',
  rooms_day integer not null default 0,
  search_window timestamptz not null default '-infinity',
  searches_window integer not null default 0,
  search_day date not null default '-infinity',
  searches_day integer not null default 0,
  paid_day integer not null default 0
);
-- No room FK: deleting a room while its provider is running must not free a slot.
create table public.search_quota_leases (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null unique,
  expires_at timestamptz not null
);
alter table public.resource_quota_limits enable row level security;
alter table public.account_resource_usage enable row level security;
alter table public.search_quota_leases enable row level security;
revoke all on public.resource_quota_limits, public.account_resource_usage,
  public.search_quota_leases from public, anon, authenticated;
create index rooms_host_active_quota on public.rooms (host_id, status, created_at);

-- NOT VALID preserves legacy rows without silently repairing/deleting user data.
-- New inserts and updates are checked, including NaN and infinities.
alter table public.rooms add constraint rooms_center_coordinates_valid check (
  center_lat between -90 and 90 and center_lng between -180 and 180
) not valid;

create or replace function public.create_room(p_lat double precision, p_lng double precision)
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
  if p_lat is null or p_lng is null or not (p_lat between -90 and 90 and p_lng between -180 and 180) then
    raise exception '無效的座標' using errcode = '22023';
  end if;
  -- ponytail: one short global admission lock; shard room locks by account if needed.
  select * into strict v_limits from public.resource_quota_limits where singleton for update;
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  insert into public.account_resource_usage (user_id) values (v_uid) on conflict do nothing;
  select * into strict v_usage from public.account_resource_usage where user_id = v_uid;
  if v_usage.room_window <= v_now - interval '10 minutes' then
    v_usage.room_window := v_now;
    v_usage.rooms_window := 0;
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

create function public.reserve_search_quota(p_user_id uuid, p_room_id uuid, p_paid_calls integer)
returns uuid language plpgsql security definer set search_path = public as $$
declare
  v_limits public.resource_quota_limits%rowtype;
  v_usage public.account_resource_usage%rowtype;
  v_now timestamptz;
  v_day date;
  v_lease uuid;
begin
  if p_paid_calls is null or p_paid_calls < 0 then
    raise exception 'invalid paid request budget' using errcode = '22023';
  end if;
  select * into strict v_limits from public.resource_quota_limits where singleton for update;
  v_now := clock_timestamp();
  v_day := (v_now at time zone 'UTC')::date;
  if not exists (select 1 from public.rooms where id = p_room_id and host_id = p_user_id and status = 'lobby') then
    return null;
  end if;
  delete from public.search_quota_leases where expires_at <= v_now;
  if exists (select 1 from public.search_quota_leases where room_id = p_room_id)
     or (select count(*) from public.search_quota_leases) >= v_limits.concurrent_search_limit then
    return null;
  end if;
  insert into public.account_resource_usage (user_id) values (p_user_id) on conflict do nothing;
  select * into strict v_usage from public.account_resource_usage where user_id = p_user_id;
  if v_usage.search_window <= v_now - interval '10 minutes' then
    v_usage.search_window := v_now;
    v_usage.searches_window := 0;
  end if;
  if v_usage.search_day <> v_day then
    v_usage.searches_day := 0;
    v_usage.paid_day := 0;
  end if;
  if v_limits.paid_day <> v_day then v_limits.paid_used := 0; end if;
  if v_usage.searches_window >= v_limits.search_window_limit
     or v_usage.searches_day >= v_limits.search_daily_limit
     or p_paid_calls > v_limits.account_paid_daily_limit - v_usage.paid_day
     or p_paid_calls > v_limits.global_paid_daily_limit - v_limits.paid_used then
    return null;
  end if;
  update public.account_resource_usage set search_window = v_usage.search_window,
    searches_window = v_usage.searches_window + 1, search_day = v_day,
    searches_day = v_usage.searches_day + 1, paid_day = v_usage.paid_day + p_paid_calls
    where user_id = p_user_id;
  update public.resource_quota_limits set paid_day = v_day, paid_used = v_limits.paid_used + p_paid_calls
    where singleton;
  -- Handler deadline is 45 seconds; leases survive a crashed process for at most 60.
  insert into public.search_quota_leases (room_id, expires_at) values (p_room_id, v_now + interval '60 seconds')
    returning id into v_lease;
  return v_lease;
end $$;

create function public.release_search_quota(p_lease uuid)
returns void language sql security definer set search_path = public as $$
  delete from public.search_quota_leases where id = p_lease;
$$;
revoke all on function public.reserve_search_quota(uuid, uuid, integer),
  public.release_search_quota(uuid) from public, anon, authenticated;
grant execute on function public.reserve_search_quota(uuid, uuid, integer),
  public.release_search_quota(uuid) to service_role;

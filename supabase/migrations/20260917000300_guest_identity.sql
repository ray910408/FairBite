-- Anonymous guests are authenticated users, but account-only actions must use
-- current auth.users state instead of a potentially stale JWT claim.
create table public.guest_email_validations (
  user_id uuid primary key references auth.users(id) on delete cascade,
  email text not null check (email = lower(btrim(email)) and char_length(email) between 3 and 254),
  phase text not null check (phase in ('validated','pending_confirmation','confirmed')),
  expires_at timestamptz not null,
  updated_at timestamptz not null default now()
);
alter table public.guest_email_validations enable row level security;
revoke all on public.guest_email_validations from public, anon, authenticated;

-- Gate only anonymous -> email identity linking. Registered users keep the
-- existing Supabase email-change behavior. The first update consumes the exact
-- server-validated address; confirmation may land only for that same address.
create function public.guard_guest_email_upgrade()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_phase text;
  v_expires timestamptz;
begin
  -- Supabase clears is_anonymous before writing the confirmed email in a
  -- separate update. Keep guarding that pending upgrade until it completes.
  if not coalesce(old.is_anonymous, false) and not exists (
    select 1 from public.guest_email_validations
      where user_id = old.id and phase = 'pending_confirmation'
  ) then return new; end if;

  if nullif(btrim(new.email_change), '') is not null
     and nullif(btrim(new.email_change), '') is distinct from nullif(btrim(old.email_change), '') then
    v_email := lower(btrim(new.email_change));
    select phase, expires_at into v_phase, v_expires
      from public.guest_email_validations
      where user_id = old.id and email = v_email for update;
    if v_phase is distinct from 'validated' or v_expires <= now() then
      raise exception 'upgrade_email_not_validated' using errcode = 'P0001';
    end if;
    update public.guest_email_validations
      set phase = 'pending_confirmation', updated_at = now()
      where user_id = old.id;
  elsif lower(coalesce(new.email, '')) is distinct from lower(coalesce(old.email, '')) then
    v_email := lower(btrim(new.email));
    select phase, expires_at into v_phase, v_expires
      from public.guest_email_validations
      where user_id = old.id and email = v_email for update;
    -- Supabase's confirmation token owns this phase's expiry. A second clock
    -- here could reject a still-valid token; exact uid+email still bind it.
    if v_phase is distinct from 'pending_confirmation' then
      raise exception 'upgrade_email_confirmation_not_validated' using errcode = 'P0001';
    end if;
    update public.guest_email_validations
      set phase = 'confirmed', updated_at = now()
      where user_id = old.id;
  end if;
  return new;
end $$;

create trigger guard_guest_email_upgrade
  before update on auth.users
  for each row execute function public.guard_guest_email_upgrade();

-- Keep the latest quota-enabled implementation and add the identity guard at
-- the RPC boundary. A verified email without a password is a resumable upgrade,
-- not a completed account.
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
  if not exists (
    select 1 from auth.users u where u.id = v_uid and not coalesce(u.is_anonymous, false)
      and (
        not exists (select 1 from public.guest_email_validations g where g.user_id = u.id)
        or exists (
          select 1 from public.guest_email_validations g where g.user_id = u.id
            and g.phase = 'confirmed' and u.email_confirmed_at is not null
            and nullif(u.encrypted_password, '') is not null
        )
      )
  ) then raise exception '訪客需完成註冊後才能建立房間' using errcode = 'P0001'; end if;
  if p_lat is null or p_lng is null or not (p_lat between -90 and 90 and p_lng between -180 and 180) then
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

-- Resolve a scanned code without exposing arbitrary rooms. Existing members
-- may resume in every phase; a new member only learns about an open lobby.
create function public.resolve_room_invite(p_code text)
returns table(room_id uuid, status text, is_member boolean)
language sql stable security definer set search_path = public as $$
  select r.id, r.status, exists (
    select 1 from public.room_members m where m.room_id = r.id and m.user_id = auth.uid()
  )
  from public.rooms r
  where auth.uid() is not null and r.code = upper(btrim(p_code))
    and (r.status = 'lobby' or exists (
      select 1 from public.room_members m where m.room_id = r.id and m.user_id = auth.uid()
    ));
$$;
revoke all on function public.resolve_room_invite(text) from public, anon;
grant execute on function public.resolve_room_invite(text) to authenticated;

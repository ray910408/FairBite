-- 2026-10-22 安全審查修復（H1／M3／L2／L8 與 guard 縱深）。

-- H1：「完成註冊」的唯一定義。create_room 與 reserve_search_quota 共用，避免兩份手抄規則漂移。
-- 已驗證 email 但還沒設密碼的訪客升級屬「可續的升級」，不算完成。
create function public.is_registered_account(p_uid uuid)
returns boolean language sql stable set search_path = '' as $$
  select exists (
    select 1 from auth.users u where u.id = p_uid and not coalesce(u.is_anonymous, false)
      and (
        not exists (select 1 from public.guest_email_validations g where g.user_id = u.id)
        or exists (
          select 1 from public.guest_email_validations g where g.user_id = u.id
            and g.phase = 'confirmed' and u.email_confirmed_at is not null
            and nullif(u.encrypted_password, '') is not null
        )
      )
  )
$$;
revoke all on function public.is_registered_account(uuid) from public, anon, authenticated;

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
  if not public.is_registered_account(v_uid) then
    raise exception '訪客需完成註冊後才能建立房間' using errcode = 'P0001';
  end if;
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

-- H1：房主退房時由最早加入者繼任（server/leave.go），繼任者可能是匿名訪客。若不在此擋，
-- 一個註冊帳號建房、匿名帳號輪流繼任搜尋，就能用 N 份帳號額度燒光全域付費額度。
-- 專屬 SQLSTATE FB001 讓 Go 端回 403 與明確文案（server/quota.go ErrGuestHostSearch）；不用通用的 42501，
-- 免得日後真正的權限錯誤被誤報成「訪客」。繼任本身已優先交給註冊成員（leave.go），這裡擋的是全員皆訪客的房。
create or replace function public.reserve_search_quota(p_user_id uuid, p_room_id uuid, p_paid_calls integer)
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
  if not public.is_registered_account(p_user_id) then
    raise exception '訪客需完成註冊後才能搜尋' using errcode = 'FB001';
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
revoke all on function public.reserve_search_quota(uuid, uuid, integer) from public, anon, authenticated;
grant execute on function public.reserve_search_quota(uuid, uuid, integer) to service_role;

-- M3：default_prefs 是成員自己可直寫的 jsonb，沒上限時匿名帳號可灌 MB 級資料耗盡 DB 儲存。
-- 正常內容（菜系、禁忌、預算、距離、交通）遠小於 4KB。not valid：既有列若已被灌過不阻擋部署，
-- 新寫入一律檢查（該列下次 UPDATE 也會被擋）。
alter table public.profiles add constraint profiles_default_prefs_bounds
  check (jsonb_typeof(default_prefs) = 'object' and octet_length(default_prefs::text) <= 4096) not valid;

-- L2：邀請碼外流時，輪替匿名帳號可無限加入、左右否決與過半表決。rooms 列已 for update，
-- 計數與插入在同一把鎖內，不會被並發加入擠爆。已是成員的重入不受上限影響。
-- 已知例外：滿房的 raise 會連同本次 join_attempts 一起回滾，不計入節流。能打到這條的人已握有
-- 有效邀請碼，沒有列舉價值；代價只是對該房 rooms 列的短暫 for update，接受以換取明確的「已滿」文案。
create or replace function public.join_room(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room_id uuid;
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  perform pg_advisory_xact_lock(hashtext('join_room:' || auth.uid()::text));
  -- ponytail: 每次呼叫順手清 10 分鐘前的舊列；join 頻率極低，全表 delete 夠用
  delete from join_attempts where attempted_at < now() - interval '10 minutes';
  if (select count(*) from join_attempts
      where user_id = auth.uid() and attempted_at > now() - interval '1 minute') >= 10 then
    raise exception '嘗試過於頻繁，請稍後再試';
  end if;
  insert into join_attempts (user_id) values (auth.uid());
  select id into v_room_id from rooms where code = upper(trim(p_code)) and status = 'lobby' for update;
  if v_room_id is null then return null; end if;
  if not exists (select 1 from room_members where room_id = v_room_id and user_id = auth.uid())
     and (select count(*) from room_members where room_id = v_room_id) >= 20 then
    raise exception '房間人數已滿' using errcode = 'P0001';
  end if;
  insert into room_members (room_id, user_id) values (v_room_id, auth.uid())
  on conflict do nothing;
  return v_room_id;
end $$;

-- L8：0008 只 grant update (rating)，沒先撤表級權限。舊專案的預設 ACL 若對 API 角色 grant all，
-- 使用者就能改自己列的 restaurant_id／decided_at，讓 restaurants_select 的 dining_history 分支變後門。
-- 無論正式站預設 ACL 為何，這裡收斂成跟本機一致。
revoke all on public.dining_history from anon, authenticated;
grant select on public.dining_history to authenticated;
grant update (rating) on public.dining_history to authenticated;

-- guard 縱深：search_version／delete_version 只由系統遞增（欄級 grant 已擋，這裡補第二層）。
-- signal_room_delete 是 security definer，以 owner 身分寫 delete_version，不受此限。
create or replace function public.guard_room_columns()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then return new; end if;
  if new.status is distinct from old.status
     or new.code is distinct from old.code
     or new.host_id is distinct from old.host_id
     or new.center_lat is distinct from old.center_lat
     or new.center_lng is distinct from old.center_lng
     or new.draw_version is distinct from old.draw_version
     or new.search_version is distinct from old.search_version
     or new.delete_version is distinct from old.delete_version then
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

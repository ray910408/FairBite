-- P2：每人同席紀錄與曝光統計（ADR-0002：無群組實體，歷史掛個人）+ 安全收緊

create table public.dining_history (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references public.profiles(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id),
  room_id uuid not null references public.rooms(id) on delete cascade,
  decided_at timestamptz not null default now(),
  rating int check (rating between 1 and 5), -- 餐後評分 P3 才有 UI，欄位先就位
  unique (room_id, user_id)                  -- 一房一抽 → 每人每房最多一筆
);

create table public.exposure_stats (
  user_id uuid not null references public.profiles(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id),
  recommended_count int not null default 0,
  chosen_count int not null default 0,
  last_chosen_at timestamptz,
  primary key (user_id, restaurant_id)
);

-- LoadRecency 的查詢形狀（user_id=any + restaurant_id=any + decided_at 範圍）；
-- PK(id) 與 unique(room_id,user_id) 都幫不上，建表時順手加（D12）
create index dining_history_recency
  on public.dining_history (user_id, restaurant_id, decided_at);

alter table public.dining_history enable row level security;
alter table public.exposure_stats enable row level security;

-- 只看得到自己的紀錄；寫入一律走 Go service role（無 to authenticated 的寫入政策）
create policy dining_history_select on public.dining_history for select to authenticated
  using (user_id = auth.uid());
create policy exposure_stats_select on public.exposure_stats for select to authenticated
  using (user_id = auth.uid());

grant select on public.dining_history to authenticated;
grant select on public.exposure_stats to authenticated;

-- ============ 安全收緊（P1 final review DEFER-P2 前三項）============

-- (1) rooms 的 UPDATE 從整表收成欄級：客戶端只可能改 exploration。
-- guard_room_columns trigger 留著當第二層防線（服務連線繞過欄級 grant 時仍受檢）
revoke update on public.rooms from authenticated;
grant update (exploration) on public.rooms to authenticated;

-- (2) 平台預設的 TRUNCATE 收回（含未來新表的 default privileges）
revoke truncate on all tables in schema public from anon, authenticated;
alter default privileges in schema public revoke truncate on tables from anon, authenticated;

-- (3) join_room 走 PostgREST、不經 Go rate limiter → 在 DB 層補限流，堵邀請碼列舉面。
-- join_attempts 無任何 policy/grant：只有 definer function 與系統連線碰得到
create table public.join_attempts (
  user_id uuid not null,
  attempted_at timestamptz not null default now()
);
create index join_attempts_user_time on public.join_attempts (user_id, attempted_at);
alter table public.join_attempts enable row level security;

-- D25：not-found 不可 raise —— raise 會回滾同交易剛寫入的 attempt，限流對列舉攻擊歸零。
-- 契約：查無/已開始 → 回 null（交易提交、嘗試留痕）；只有未登入與限流仍 raise
--（限流 raise 時前 10 筆已提交，機制仍有效）。web 端把 null 映射成「房間不存在或已開始」（Task 8）。
create or replace function public.join_room(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room_id uuid;
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  -- ponytail: 每次呼叫順手清 10 分鐘前的舊列；join 頻率極低，全表 delete 夠用
  delete from join_attempts where attempted_at < now() - interval '10 minutes';
  if (select count(*) from join_attempts
      where user_id = auth.uid() and attempted_at > now() - interval '1 minute') >= 10 then
    raise exception '嘗試過於頻繁，請稍後再試';
  end if;
  insert into join_attempts (user_id) values (auth.uid());
  select id into v_room_id from rooms where code = upper(trim(p_code)) and status = 'lobby';
  if v_room_id is null then return null; end if;
  insert into room_members (room_id, user_id) values (v_room_id, auth.uid())
  on conflict do nothing;
  return v_room_id;
end $$;

-- (4) 探索檔位僅能在 lobby 調整（spec §7）：擴充既有 guard trigger
-- （D5：順手補 set search_path —— TODOS #5；invoker security 維持不變，見 0001 的 ponytail 註解）
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
  return new;
end $$;

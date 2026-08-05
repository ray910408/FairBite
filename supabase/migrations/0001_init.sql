-- P1 tables. votes / dining_history / exposure_stats 屬 P2，另開 migration。

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  display_name text not null default '',
  default_prefs jsonb not null default '{}',
  created_at timestamptz not null default now()
);

create table public.rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6)),
  host_id uuid not null references public.profiles(id),
  status text not null default 'lobby' check (status in ('lobby','candidates','decided')),
  center_lat double precision,
  center_lng double precision,
  exploration text not null default 'balanced' check (exploration in ('familiar','balanced','explore')),
  created_at timestamptz not null default now()
);

create table public.room_members (
  room_id uuid references public.rooms(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete cascade,
  budget_max int not null default 300 check (budget_max between 0 and 100000),
  cuisines jsonb not null default '[]' check (jsonb_typeof(cuisines) = 'array'),
  dietary jsonb not null default '[]' check (jsonb_typeof(dietary) = 'array'),
  max_distance_m int not null default 800 check (max_distance_m between 100 and 20000),
  transport text not null default 'walking' check (transport in ('walking','driving','transit')),
  ready boolean not null default false,
  joined_at timestamptz not null default now(),
  primary key (room_id, user_id)
);

create table public.restaurants (
  id uuid primary key default gen_random_uuid(),
  place_id text not null unique,
  name text not null,
  cuisine_tags jsonb not null default '[]',
  price_level int not null default 2,
  lat double precision not null,
  lng double precision not null,
  address text not null default '',
  opening_hours jsonb not null default '{}',
  rating numeric,
  fetched_at timestamptz not null default now()
);

create table public.room_candidates (
  room_id uuid references public.rooms(id) on delete cascade,
  restaurant_id uuid references public.restaurants(id),
  status text not null check (status in ('kept','excluded')),
  probability numeric,
  weight_breakdown jsonb not null default '[]',
  exclusion_reason text,
  primary key (room_id, restaurant_id)
);

create table public.draws (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null unique references public.rooms(id) on delete cascade,
  seed text not null,
  winner_restaurant_id uuid not null references public.restaurants(id),
  probabilities jsonb not null,
  created_at timestamptz not null default now()
);

-- 新使用者自動建 profile
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles (id, display_name)
  values (new.id, coalesce(new.raw_user_meta_data->>'display_name', split_part(new.email, '@', 1)));
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- RLS helper：security definer 避免 room_members 政策自我遞迴
create or replace function public.is_room_member(p_room_id uuid)
returns boolean language sql stable security definer set search_path = public as $$
  select exists (select 1 from room_members where room_id = p_room_id and user_id = auth.uid());
$$;

-- 建房與加入走 security definer：原子性 + 不需開放 rooms 的 insert/select-by-code 政策
create or replace function public.create_room(p_lat double precision, p_lng double precision)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room_id uuid;
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  insert into rooms (host_id, center_lat, center_lng)
  values (auth.uid(), p_lat, p_lng) returning id into v_room_id;
  insert into room_members (room_id, user_id) values (v_room_id, auth.uid());
  return v_room_id;
end $$;

create or replace function public.join_room(p_code text)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room_id uuid;
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  select id into v_room_id from rooms where code = upper(trim(p_code)) and status = 'lobby';
  if v_room_id is null then raise exception '房間不存在或已開始'; end if;
  insert into room_members (room_id, user_id) values (v_room_id, auth.uid())
  on conflict do nothing;
  return v_room_id;
end $$;

revoke execute on function public.create_room, public.join_room, public.is_room_member from anon, public;
grant execute on function public.create_room, public.join_room, public.is_room_member to authenticated;

-- RLS
alter table public.profiles enable row level security;
alter table public.rooms enable row level security;
alter table public.room_members enable row level security;
alter table public.restaurants enable row level security;
alter table public.room_candidates enable row level security;
alter table public.draws enable row level security;

-- ponytail: default_prefs 對所有登入者可讀（低敏感），P2 若要收緊改用 view
create policy profiles_select on public.profiles for select to authenticated using (true);
create policy profiles_update on public.profiles for update to authenticated
  using (id = auth.uid()) with check (id = auth.uid());

create policy rooms_select on public.rooms for select to authenticated using (is_room_member(id));
-- ponytail: host 可 update 整列（含 status）；惡意 host 只能弄壞自己房間，P2 再用 trigger 鎖 status
create policy rooms_update on public.rooms for update to authenticated
  using (host_id = auth.uid()) with check (host_id = auth.uid());

create policy members_select on public.room_members for select to authenticated using (is_room_member(room_id));
-- 條件只能在 lobby 階段修改：候選出爐後凍結（繞過 UI 直打 API 也會被擋）
create policy members_update on public.room_members for update to authenticated
  using (user_id = auth.uid()
    and exists (select 1 from rooms r where r.id = room_id and r.status = 'lobby'))
  with check (user_id = auth.uid()
    and exists (select 1 from rooms r where r.id = room_id and r.status = 'lobby'));

create policy restaurants_select on public.restaurants for select to authenticated using (true);
create policy candidates_select on public.room_candidates for select to authenticated using (is_room_member(room_id));
create policy draws_select on public.draws for select to authenticated using (is_room_member(room_id));
-- 沒有任何 to authenticated 的 insert/delete 政策：寫入走 definer functions 與 Go service role

-- ponytail: RLS policy 不會自動生效——Postgres 要求 table-level GRANT 才會走到 RLS 檢查，
-- 否則直接 permission denied（policy 形同虛設）。逐一對應上面每條 to authenticated 政策，
-- 不多不少：select/update 給有 update 政策的三張表，其餘只給 select。
grant select, update on public.profiles to authenticated;
grant select, update on public.rooms to authenticated;
grant select, update on public.room_members to authenticated;
grant select on public.restaurants to authenticated;
grant select on public.room_candidates to authenticated;
grant select on public.draws to authenticated;

-- rooms 敏感欄位只有系統連線可改（狀態機完整性 = 抽選可信度的地基）；
-- 客戶端（authenticated）僅能調 exploration
-- ponytail: 這裡刻意不用 security definer——definer 會把 current_user 換成 function
-- owner（postgres），導致下面的 current_user 判斷對任何呼叫者永遠為真，guard 形同虛設。
-- 用預設的 security invoker，current_user 才會正確反映真正呼叫者的角色。
create or replace function public.guard_room_columns()
returns trigger language plpgsql as $$
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
  return new;
end $$;

create trigger rooms_guard before update on public.rooms
  for each row execute function public.guard_room_columns();

-- Realtime
alter publication supabase_realtime add table public.rooms, public.room_members, public.room_candidates, public.draws;

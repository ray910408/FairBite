-- 初選（Shortlist，ADR-0010）：candidates 與 voting 之間的可選階段。
-- 寫入一律走 Go 房間交易（service role）；client 只讀，跟 location_change_votes 同一套。
alter table public.rooms drop constraint rooms_status_check;
alter table public.rooms add constraint rooms_status_check
  check (status in ('lobby','candidates','shortlisting','voting','relocating','pending','decided'));

-- 開始投票時定案的落選旗標；重算以它為輸入，退房不得讓落選店復活（ADR-0010）
alter table public.room_candidates
  add column shortlist_excluded boolean not null default false;

-- 初選表決意願（候選出爐階段）
create table public.shortlist_votes (
  room_id uuid not null,
  user_id uuid not null,
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.room_members(room_id, user_id) on delete cascade
);

-- 圈選：不掛 room_candidates 的 FK——重算會整批刪掉重寫候選列
create table public.shortlist_picks (
  room_id uuid not null,
  user_id uuid not null,
  restaurant_id uuid not null references public.restaurants(id),
  primary key (room_id, user_id, restaurant_id),
  foreign key (room_id, user_id) references public.room_members(room_id, user_id) on delete cascade
);

alter table public.shortlist_votes enable row level security;
alter table public.shortlist_picks enable row level security;
create policy shortlist_votes_select on public.shortlist_votes
  for select to authenticated using (public.is_room_member(room_id));
create policy shortlist_picks_select on public.shortlist_picks
  for select to authenticated using (public.is_room_member(room_id));
revoke all on public.shortlist_votes, public.shortlist_picks from anon, authenticated;
grant select on public.shortlist_votes, public.shortlist_picks to authenticated;
grant all on public.shortlist_votes, public.shortlist_picks to service_role;
alter publication supabase_realtime add table public.shortlist_votes;
alter publication supabase_realtime add table public.shortlist_picks;

-- 回到準備階段＝新一輪搜尋：初選表決與圈選跟改地點意願一起清掉
create or replace function public.advance_room_search_version()
returns trigger language plpgsql set search_path = public as $$
begin
  if (old.status <> 'lobby' and new.status = 'lobby')
     or new.center_lat is distinct from old.center_lat
     or new.center_lng is distinct from old.center_lng
     or new.search_version is distinct from old.search_version then
    new.search_version := old.search_version + 1;
    delete from public.location_change_votes where room_id = old.id;
    delete from public.shortlist_votes where room_id = old.id;
    delete from public.shortlist_picks where room_id = old.id;
  else
    new.search_version := old.search_version;
  end if;
  return new;
end $$;

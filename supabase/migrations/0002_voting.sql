-- P2：房間狀態機插入 voting；votes 表（唯讀 RLS —— 寫入唯一入口是 Go POST /vote）
--
-- 狀態機（Task 0 修訂後的 spec §6）：
--   lobby ─search(host)→ candidates ─start-voting(host)→ voting ─draw(host)→ decided
--   投票只存在於 voting；所有轉換 = Go 條件更新（WHERE status='<expected>'）
--
-- D15：限額/階段/互斥全在 Go 的 vote 交易內把關（weights.go 的 VetoQuota）。
-- DB 只保留宣告式 invariant：PK 四欄（同人同店同 kind 唯一）、kind CHECK、FK、唯讀 RLS。

alter table public.rooms drop constraint rooms_status_check;
alter table public.rooms add constraint rooms_status_check
  check (status in ('lobby','candidates','voting','decided'));

create table public.votes (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  restaurant_id uuid not null references public.restaurants(id),
  kind text not null check (kind in ('up','veto')),
  created_at timestamptz not null default now(),
  primary key (room_id, user_id, restaurant_id, kind)
);

alter table public.votes enable row level security;

-- 全房透明：成員可看所有票（可解釋性是核心論述）。
-- 沒有任何 to authenticated 的 insert/delete 政策與 grant：
-- 寫入走 Go（service role），grant 矩陣 pin 會鎖住這個前提
create policy votes_select on public.votes for select to authenticated
  using (is_room_member(room_id));

grant select on public.votes to authenticated;

alter publication supabase_realtime add table public.votes;

-- A draw is now an immutable audit snapshot. Only confirmation finalizes dining history.
alter table public.rooms drop constraint rooms_status_check;
alter table public.rooms add constraint rooms_status_check
  check (status in ('lobby','candidates','voting','pending','decided'));
alter table public.rooms add column draw_version bigint not null default 0 check (draw_version >= 0);
grant select (draw_version) on public.rooms to authenticated;

create or replace function public.guard_room_columns()
returns trigger language plpgsql set search_path = public as $$
begin
  if current_user in ('postgres', 'service_role', 'supabase_admin') then return new; end if;
  if new.status is distinct from old.status
     or new.code is distinct from old.code
     or new.host_id is distinct from old.host_id
     or new.center_lat is distinct from old.center_lat
     or new.center_lng is distinct from old.center_lng
     or new.draw_version is distinct from old.draw_version then
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

alter table public.draws drop constraint draws_room_id_key;
alter table public.draws add column version bigint;
update public.draws set version = 1;
alter table public.draws alter column version set not null;
alter table public.draws add constraint draws_room_version_key unique (room_id, version);
update public.rooms r set draw_version = 1
where exists (select 1 from public.draws d where d.room_id = r.id);

alter table public.room_candidates
  add column batch_excluded boolean not null default false;

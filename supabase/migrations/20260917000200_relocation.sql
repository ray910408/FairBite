-- Relocation is a separate majority decision. Writes remain in the Go room transaction.
alter table public.rooms drop constraint rooms_status_check;
alter table public.rooms add constraint rooms_status_check
  check (status in ('lobby','candidates','voting','relocating','pending','decided'));
alter table public.rooms add column search_version bigint not null default 0
  check (search_version >= 0);
grant select (search_version) on public.rooms to authenticated;

create table public.location_change_votes (
  room_id uuid not null,
  user_id uuid not null,
  primary key (room_id, user_id),
  foreign key (room_id, user_id) references public.room_members(room_id, user_id) on delete cascade
);
alter table public.location_change_votes enable row level security;
create policy location_change_votes_select on public.location_change_votes
  for select to authenticated using (public.is_room_member(room_id));
revoke all on public.location_change_votes from anon, authenticated;
grant select on public.location_change_votes to authenticated;
grant all on public.location_change_votes to service_role;
alter publication supabase_realtime add table public.location_change_votes;

-- A round can return to identical coordinates. Incrementing here covers every
-- existing reset path, including exhausted draws and editing candidate conditions.
create function public.advance_room_search_version()
returns trigger language plpgsql set search_path = public as $$
begin
  if (old.status <> 'lobby' and new.status = 'lobby')
     or new.center_lat is distinct from old.center_lat
     or new.center_lng is distinct from old.center_lng
     or new.search_version is distinct from old.search_version then
    new.search_version := old.search_version + 1;
    delete from public.location_change_votes where room_id = old.id;
  else
    new.search_version := old.search_version;
  end if;
  return new;
end $$;
create trigger rooms_search_version before update on public.rooms
  for each row execute function public.advance_room_search_version();

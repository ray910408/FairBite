-- Readiness belongs to one search round. Serialize with every room reset and
-- reject delayed clients after search_version advances.
create function public.set_member_ready(
  p_room_id uuid,
  p_ready boolean,
  p_search_version bigint
)
returns boolean
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_status text;
  v_search_version bigint;
  v_updated bigint;
begin
  if auth.uid() is null or p_room_id is null or p_ready is null or p_search_version is null then
    return false;
  end if;

  select status, search_version into v_status, v_search_version
  from public.rooms where id = p_room_id for update;
  if not found or v_status <> 'lobby' or v_search_version <> p_search_version then
    return false;
  end if;

  update public.room_members set ready = p_ready
  where room_id = p_room_id and user_id = auth.uid();
  get diagnostics v_updated = row_count;
  return v_updated = 1;
end $$;

revoke execute on function public.set_member_ready(uuid,boolean,bigint) from public, anon;
grant execute on function public.set_member_ready(uuid,boolean,bigint) to authenticated;
revoke update (ready) on public.room_members from authenticated;

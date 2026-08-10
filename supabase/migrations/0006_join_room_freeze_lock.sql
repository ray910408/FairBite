-- Freeze serialization: lock the matching rooms row so a join either commits before
-- handleSearch snapshots members or waits behind the lobby -> candidates transition.
-- Lock order stays per-user advisory lock -> rooms row -> room_members insert, matching
-- the rooms-first order used by handleSearch/vote/draw for shared room/member data.
-- Under READ COMMITTED, a blocked join re-evaluates status = 'lobby' after the transition
-- commits and falls through to null.  The join_attempt was already inserted, preserving
-- D25 anti-enumeration accounting without changing the not-found or raise paths.
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
  insert into room_members (room_id, user_id) values (v_room_id, auth.uid())
  on conflict do nothing;
  return v_room_id;
end $$;

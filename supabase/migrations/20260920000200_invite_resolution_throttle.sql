-- Resolution exposes invite validity, so it must spend the same per-user budget
-- as join_room. Both RPCs serialize on the same lock before counting attempts.
create or replace function public.resolve_room_invite(p_code text)
returns table(room_id uuid, status text, is_member boolean)
language plpgsql volatile security definer set search_path = public as $$
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  perform pg_advisory_xact_lock(hashtext('join_room:' || auth.uid()::text));
  delete from public.join_attempts where attempted_at < now() - interval '10 minutes';
  if (select count(*) from public.join_attempts
      where user_id = auth.uid() and attempted_at > now() - interval '1 minute') >= 10 then
    raise exception '嘗試過於頻繁，請稍後再試';
  end if;
  insert into public.join_attempts (user_id) values (auth.uid());

  -- Empty results must return normally so failed guesses keep their attempt.
  return query
    select r.id, r.status, exists (
      select 1 from public.room_members m where m.room_id = r.id and m.user_id = auth.uid()
    )
    from public.rooms r
    where r.code = upper(btrim(p_code))
      and (r.status = 'lobby' or exists (
        select 1 from public.room_members m where m.room_id = r.id and m.user_id = auth.uid()
      ));
end $$;
revoke all on function public.resolve_room_invite(text) from public, anon;
grant execute on function public.resolve_room_invite(text) to authenticated;

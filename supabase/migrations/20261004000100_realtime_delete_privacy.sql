-- Realtime 對 DELETE 不套 RLS（realtime.apply_rls 直接放行，old 只裁到 PK），任何登入者都能
-- 收到別房的票、圈選、退房與候選清單刪除事件（ADR-0011）。整個 publication 停發 DELETE，
-- 現有與日後加入的表一次堵住；成員改由 rooms 的 UPDATE（經 RLS）得知房內有刪除。
alter publication supabase_realtime set (publish = 'insert, update, truncate');

-- 純訊號欄：前端收到任何事件都只 refetch，不讀內容，所以不 grant 給 authenticated
alter table public.rooms add column delete_version bigint not null default 0;

create function public.signal_room_delete()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  -- 只跳過 trigger 內發出的刪除：rooms 的 BEFORE UPDATE（advance_room_search_version）清子表時
  -- 外層 UPDATE 本身就會推播，這裡回寫同一列會讓外層撞 tuple already modified。
  -- FK cascade 由外層語句收尾觸發（depth 1）照常遞增；刪房時只是對已刪列的空 UPDATE
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  update public.rooms set delete_version = delete_version + 1
   where id in (select distinct room_id from gone);
  return null;
end $$;

create trigger votes_signal_delete after delete on public.votes
  referencing old table as gone for each statement execute function public.signal_room_delete();
create trigger room_members_signal_delete after delete on public.room_members
  referencing old table as gone for each statement execute function public.signal_room_delete();
create trigger room_candidates_signal_delete after delete on public.room_candidates
  referencing old table as gone for each statement execute function public.signal_room_delete();
create trigger draws_signal_delete after delete on public.draws
  referencing old table as gone for each statement execute function public.signal_room_delete();
create trigger location_change_votes_signal_delete after delete on public.location_change_votes
  referencing old table as gone for each statement execute function public.signal_room_delete();
create trigger shortlist_votes_signal_delete after delete on public.shortlist_votes
  referencing old table as gone for each statement execute function public.signal_room_delete();
create trigger shortlist_picks_signal_delete after delete on public.shortlist_picks
  referencing old table as gone for each statement execute function public.signal_room_delete();

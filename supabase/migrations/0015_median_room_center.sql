-- 搜尋圓心從「房主的位置」改成「全員位置的中位數」。
-- 原本 join_room 只收邀請碼，組員的座標從未進過系統，遠道而來的人只能靠
-- max_distance_m 把搜尋圈縮小（handlers.go minimumMemberRadius），圈心卻永遠在房主身上。
--
-- 座標另立一張表而不是加在 room_members：members_select 讓同房成員讀得到整列，
-- 精確座標塞進去等於把每個人的所在地攤給任何拿到邀請碼的人。這張表不開任何
-- authenticated grant，只有 security definer function 與 service role 進得來。
create table public.room_member_locations (
  room_id uuid not null references public.rooms(id) on delete cascade,
  user_id uuid not null references public.profiles(id) on delete cascade,
  lat double precision not null check (lat between -90 and 90),
  lng double precision not null check (lng between -180 and 180),
  primary key (room_id, user_id)
);
alter table public.room_member_locations enable row level security;
-- 刻意沒有任何 policy 也沒有任何 grant：authenticated 讀不到也寫不到

-- 既有房間補房主那一列，否則下次 recompute 會在空集合上算中位數而原地不動
insert into public.room_member_locations (room_id, user_id, lat, lng)
select id, host_id, center_lat, center_lng from public.rooms
where center_lat between -90 and 90 and center_lng between -180 and 180
on conflict do nothing;

-- ponytail: 逐維中位數（lat 算一次、lng 算一次），不是幾何中位數；偶數人數 percentile_cont
-- 會內插，兩人時剛好等於連線中點。要真幾何中位數得跑 Weiszfeld 迭代，這裡不值得。
create or replace function public.recompute_room_center(p_room_id uuid)
returns void language sql security definer set search_path = public as $$
  update rooms r
     set center_lat = c.lat, center_lng = c.lng
    from (select percentile_cont(0.5) within group (order by lat) as lat,
                 percentile_cont(0.5) within group (order by lng) as lng
            from room_member_locations where room_id = p_room_id) c
   where r.id = p_room_id and c.lat is not null;
$$;
-- 只由下面兩支 definer function 內部呼叫（definer 內 current_user 已是 owner），不對外開
revoke execute on function public.recompute_room_center from anon, public;

-- create_room：房主的座標同時進 location 表。單人中位數就是房主自己，
-- center_* 維持直接寫入，不必多跑一次 recompute。
-- 附帶效果：p_lat/p_lng 現在會被 location 表的 CHECK 擋，過去是照單全收。
create or replace function public.create_room(p_lat double precision, p_lng double precision)
returns uuid language plpgsql security definer set search_path = public as $$
declare v_room_id uuid;
begin
  if auth.uid() is null then raise exception '未登入'; end if;
  insert into rooms (host_id, center_lat, center_lng)
  values (auth.uid(), p_lat, p_lng) returning id into v_room_id;
  insert into room_members (room_id, user_id) values (v_room_id, auth.uid());
  insert into room_member_locations (room_id, user_id, lat, lng)
  values (v_room_id, auth.uid(), p_lat, p_lng);
  return v_room_id;
end $$;

-- join_room 加收座標。0006 的 rate limit 與 rooms for update 鎖序原樣保留：
-- 圓心重算跟著在同一把 rooms row lock 底下發生，不會和 lobby -> candidates 轉場交錯。
-- 舊簽章直接 drop：加 default 參數會多出一支同名 function，一引數呼叫會撞 ambiguous。
drop function public.join_room(text);
create function public.join_room(
  p_code text,
  p_lat double precision default null,
  p_lng double precision default null)
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
  -- 沒給座標（使用者拒絕定位）就不進中位數，圓心維持原樣，人照樣加得進來
  if p_lat is not null and p_lng is not null then
    insert into room_member_locations (room_id, user_id, lat, lng)
    values (v_room_id, auth.uid(), p_lat, p_lng)
    on conflict (room_id, user_id) do update set lat = excluded.lat, lng = excluded.lng;
    perform recompute_room_center(v_room_id);
  end if;
  return v_room_id;
end $$;

revoke execute on function public.join_room(text, double precision, double precision) from anon, public;
grant execute on function public.join_room(text, double precision, double precision) to authenticated;

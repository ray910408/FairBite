-- P2 security audit（VERIFIED MEDIUM ×2）
--
-- (1) profiles_select 原為 using (true)：任何登入者可枚舉全表。收成「自己或同房成員」；
--     RoomPage 經 room_members embed 讀同房 display_name 的路徑由第二個分支保住。
-- (2) 邀請碼 6 hex（2^24）有水平枚舉面；改 12 hex（48 bits——UUIDv4 去 dash 後
--     前 12 字元全隨機，version nibble 在第 13 位）。既有房間舊碼不回填：
--     尚無 production 部署，且回填會弄壞已分享的碼。

drop policy profiles_select on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using (id = auth.uid() or exists (
    select 1 from room_members m where m.user_id = profiles.id and is_room_member(m.room_id)));

alter table public.rooms alter column code
  set default upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 12));

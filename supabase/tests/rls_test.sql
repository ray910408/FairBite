begin;
create extension if not exists pgtap with schema extensions;
select plan(32);

-- 回歸鎖：authenticated 對 public 表的 grant 矩陣必須精確等於預期矩陣。
-- create_room/join_room 是唯一合法寫入入口；這條 pin 住的就是那個前提——
-- 誰若把某表的 grant 改寬成含 insert/delete，這裡就會紅（不用等有人真的繞過 RPC 才發現）。
select results_eq(
  $$
    select table_name::text collate "default", privilege_type::text collate "default"
    from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
    order by 1, 2
  $$,
  $$
    values
      ('dining_history','SELECT'),
      ('draws','SELECT'),
      ('exposure_stats','SELECT'),
      ('profiles','SELECT'), ('profiles','UPDATE'),
      ('restaurants','SELECT'),
      ('room_candidates','SELECT'),
      ('room_members','SELECT'), ('room_members','UPDATE'),
      ('rooms','SELECT'),
      ('votes','SELECT')
    order by 1, 2
  $$,
  'authenticated 的 table grant 矩陣精確等於預期（多/少/換一條即紅，擋 insert/delete bypass 回歸）'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@test.dev'),
  ('00000000-0000-0000-0000-0000000000b2', 'b@test.dev');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select lives_ok($$select public.create_room(25.0478, 121.5170)$$, 'A 可建房');
create temp table ctx as select id, code from public.rooms limit 1;

set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*) from public.rooms)::int, 0, 'B 未加入前看不到房間');
select lives_ok(format($$select public.join_room(%L)$$, (select code from ctx)), 'B 可用邀請碼加入');
select is((select count(*) from public.rooms)::int, 1, 'B 加入後看得到房間');

update public.room_members set ready = true
  where user_id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select count(*) from public.room_members
    where user_id = '00000000-0000-0000-0000-0000000000a1' and ready)::int,
  0, 'B 改不動 A 的成員列');

-- lobby 凍結：房間離開 lobby 後，本人也改不動條件
reset role;
update public.rooms set status = 'candidates' where id = (select id from ctx);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
update public.room_members set ready = true
  where user_id = '00000000-0000-0000-0000-0000000000b2';
select is(
  (select count(*) from public.room_members
    where user_id = '00000000-0000-0000-0000-0000000000b2' and ready)::int,
  0, '離開 lobby 後本人也改不動條件');

-- join_room 對已開始的房間應拒絕
select is(
  (select public.join_room((select code from ctx))), null,
  'join_room 對已開始的房間回 null（D25：raise 會回滾 attempt）');
reset role;
select is(
  (select count(*) from public.join_attempts
    where user_id = '00000000-0000-0000-0000-0000000000b2')::int,
  2, '失敗的 join 嘗試會留痕（成功 1 + 失敗 1）');
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';

-- 房主（A）也不能直接改 rooms 敏感欄位（status 由 Go 服務管理）
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select throws_like(
  format($$update public.rooms set status = 'decided' where id = %L$$, (select id from ctx)),
  '%permission denied%', '欄級 grant 擋掉 status 直改');

-- ============ P2：votes 唯讀 RLS（寫入走 Go，D15/D9）============
reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c3', 'c@test.dev');
insert into public.restaurants (id, place_id, name, lat, lng, source) values
  ('99999999-9999-9999-9999-999999999901', 'pg-1', '測試餐廳一', 25.04, 121.51, 'google');
insert into public.room_candidates (room_id, restaurant_id, status, probability) values
  ((select id from ctx), '99999999-9999-9999-9999-999999999901', 'kept', 1);
-- 模擬 Go service role 寫入的一張票
insert into public.votes (room_id, user_id, restaurant_id, kind) values
  ((select id from ctx), '00000000-0000-0000-0000-0000000000a1',
   '99999999-9999-9999-9999-999999999901', 'up');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is(
  (select count(*) from public.restaurants
    where id in (select restaurant_id from public.room_candidates))::int,
  1, '房間成員看得到本房候選引用的餐廳');
select is((select count(*) from public.votes)::int, 1, '成員看得到全房的票');

select throws_like(format(
  $$insert into public.votes (room_id, user_id, restaurant_id, kind)
    values (%L, '00000000-0000-0000-0000-0000000000b2', '99999999-9999-9999-9999-999999999901', 'up')$$,
  (select id from ctx)),
  '%permission denied%', 'authenticated 無 INSERT grant（寫入走 Go）');
select throws_like(
  $$delete from public.votes$$,
  '%permission denied%', 'authenticated 無 DELETE grant（收回也走 Go）');

-- 非成員（C）看不到任何票（D9：policy 否定面）
reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}';
select is(
  (select count(*) from public.restaurants
    where id = '99999999-9999-9999-9999-999999999901')::int,
  0, '非成員看不到其他房間候選引用的餐廳');
select is((select count(*) from public.votes)::int, 0, '非成員看不到任何票');

-- ============ P2：欄級 grant、探索檔位、join 限流、同席紀錄 ============
-- D17：information_schema 只顯示「當前啟用角色」的 grant——不 reset role 的話
-- anon 那半斷言永遠回空（有人 grant 回去也照綠）。先回 postgres 再驗。
reset role;
select results_eq(
  $$
    select column_name::text collate "default"
    from information_schema.role_column_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'rooms' and privilege_type = 'UPDATE'
  $$,
  $$ values ('exploration') $$,
  'rooms 的 UPDATE 欄級 grant 僅 exploration');

select is(
  (select count(*) from information_schema.role_table_grants
    where grantee in ('anon','authenticated') and table_schema = 'public'
      and privilege_type = 'TRUNCATE')::int,
  0, 'anon/authenticated 無 TRUNCATE');

-- 探索檔位：lobby 可調、非 lobby 鎖
reset role;
update public.rooms set status = 'lobby' where id = (select id from ctx);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok(
  format($$update public.rooms set exploration = 'explore' where id = %L$$, (select id from ctx)),
  '房主可在 lobby 調探索檔位');
select is(
  (select exploration from public.rooms where id = (select id from ctx)),
  'explore', '檔位已更新');
reset role;
update public.rooms set status = 'candidates' where id = (select id from ctx);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select throws_ok(
  format($$update public.rooms set exploration = 'familiar' where id = %L$$, (select id from ctx)),
  '探索檔位僅能在等待階段調整');

-- join_room 限流：一分鐘內第 11 次嘗試被拒（先灌 10 筆再打）
reset role;
insert into public.join_attempts (user_id)
  select '00000000-0000-0000-0000-0000000000b2' from generate_series(1, 10);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.join_room('XXXXXX')$$, '嘗試過於頻繁，請稍後再試');

-- 同席紀錄只看得到自己的
reset role;
insert into public.dining_history (user_id, restaurant_id, room_id) values
  ('00000000-0000-0000-0000-0000000000a1', '99999999-9999-9999-9999-999999999901', (select id from ctx)),
  ('00000000-0000-0000-0000-0000000000b2', '99999999-9999-9999-9999-999999999901', (select id from ctx));
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*) from public.dining_history)::int, 1, '只看得到自己的同席紀錄');

-- ============ 0004：profiles 可見性收緊 + 邀請碼 12 碼 ============
-- B 與 A 同房、C 無共同房。B 的可見集合精確等於 {自己, A}——同房互查保住
-- （RoomPage 的 room_members embed 路徑），無共同房的 C 不可見。
select results_eq(
  $$select id from public.profiles order by id$$,
  $$values ('00000000-0000-0000-0000-0000000000a1'::uuid),
           ('00000000-0000-0000-0000-0000000000b2'::uuid)$$,
  'B 看得到自己與同房的 A，看不到無共同房的 C');
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}';
select is((select count(*) from public.profiles)::int, 1, '無共同房間者只看得到自己的 profile');
select is(length((select code from ctx)), 12, '新房邀請碼為 12 碼');

-- P3 餐後評分：自己的紀錄可評分，別人的碰不到（欄級 grant 只開 rating）
reset role;
select results_eq(
  $$
    select column_name::text collate "default"
    from information_schema.role_column_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'dining_history' and privilege_type = 'UPDATE'
  $$,
  $$ values ('rating') $$,
  'dining_history 的 UPDATE 欄級 grant 僅 rating');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
update public.dining_history set rating = 4
  where user_id = '00000000-0000-0000-0000-0000000000b2';
select is(
  (select rating from public.dining_history
    where user_id = '00000000-0000-0000-0000-0000000000b2'),
  4, 'B 可評自己的同席紀錄');
update public.dining_history set rating = 1
  where user_id = '00000000-0000-0000-0000-0000000000a1';
-- 空斷言陷阱（OV#14）：B 的 RLS 本來就看不到 A 的列，在 B 的 context 下數恆為 0、
-- RLS 壞了也綠。必須 reset role 用特權視角數（比照 rls_test.sql:70 的既有寫法）。
reset role;
select is(
  (select count(*) from public.dining_history
    where user_id = '00000000-0000-0000-0000-0000000000a1' and rating is not null)::int,
  0, 'B 改不動 A 的評分');
-- 0003 的 rating CHECK 至今無測試，順手釘住（eng review Test Review）
select throws_ok(
  $$update public.dining_history set rating = 6
     where user_id = '00000000-0000-0000-0000-0000000000b2'$$,
  '23514', null, 'rating 超界被 CHECK 擋下');

-- D5：非字串元素在 DB 邊界就擋，堵掉「LoadMembers unmarshal 失敗 → 全房 500」
reset role;
select throws_ok(
  $$update public.room_members set cuisines = '["japanese", 5]'::jsonb
     where user_id = '00000000-0000-0000-0000-0000000000b2'$$,
  '23514', null,
  'cuisines 非字串元素被 CHECK 擋下');

-- ADR-0002：紀錄跟人 —— 刪房不得抹掉同席紀錄
reset role;
delete from public.rooms where id = (select id from ctx);
select is(
  (select count(*) from public.dining_history
    where user_id = '00000000-0000-0000-0000-0000000000a1' and room_id is null)::int,
  1, '刪房後同席紀錄仍在，room_id 轉為 null');

select * from finish();
rollback;

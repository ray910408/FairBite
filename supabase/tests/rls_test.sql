begin;
create extension if not exists pgtap with schema extensions;
select plan(9);

-- 回歸鎖：authenticated 對 public 表的 grant 矩陣必須精確等於這 9 列。
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
      ('draws','SELECT'),
      ('profiles','SELECT'), ('profiles','UPDATE'),
      ('restaurants','SELECT'),
      ('room_candidates','SELECT'),
      ('room_members','SELECT'), ('room_members','UPDATE'),
      ('rooms','SELECT'), ('rooms','UPDATE')
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
select throws_ok(
  format($$select public.join_room(%L)$$, (select code from ctx)),
  '房間不存在或已開始');

-- 房主（A）也不能直接改 rooms 敏感欄位（status 由 Go 服務管理）
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select throws_ok(
  format($$update public.rooms set status = 'decided' where id = %L$$, (select id from ctx)),
  '僅系統可修改房間狀態欄位');

select * from finish();
rollback;

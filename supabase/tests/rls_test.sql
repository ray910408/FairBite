begin;
create extension if not exists pgtap with schema extensions;
select plan(8);

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

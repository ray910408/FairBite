begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- 發起聚餐可先不帶出發點（20261105000100）：之後由房主在準備階段選。
insert into auth.users (id, email) values ('c1050000-0000-4000-8000-000000000001', 'later-host@test.dev');
update public.resource_quota_limits set active_room_limit = 10, room_window_limit = 10, room_daily_limit = 10;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c1050000-0000-4000-8000-000000000001","role":"authenticated"}';
create temp table later_room as select public.create_room() as id;
create temp table located_room as select public.create_room(25, 121) as id;
select throws_ok($$select public.create_room(25, null)$$, '22023', '無效的座標', 'only latitude is still invalid');
select throws_ok($$select public.create_room(null, 121)$$, '22023', '無效的座標', 'only longitude is still invalid');
select is((select has_location from public.rooms where id = (select id from later_room)), false,
  'room created without a departure point reports has_location = false');
select is((select has_location from public.rooms where id = (select id from located_room)), true,
  'room created with a departure point reports has_location = true');
select throws_ok($$select center_lat from public.rooms where id = (select id from later_room)$$, '42501', null,
  'members still cannot read the departure point itself');
reset role;

select ok(exists(select 1 from public.room_members where room_id = (select id from later_room)
  and user_id = 'c1050000-0000-4000-8000-000000000001'), 'host joins the room without a departure point');
select is((select status from public.rooms where id = (select id from later_room)), 'lobby', 'room starts in lobby');

-- 房主之後選點（同 relocation.go 的 UPDATE）：has_location 跟著變
update public.rooms set center_lat = 25.0478, center_lng = 121.517 where id = (select id from later_room);
select is((select has_location from public.rooms where id = (select id from later_room)), true,
  'choosing a departure point later flips has_location');

select * from finish();
rollback;

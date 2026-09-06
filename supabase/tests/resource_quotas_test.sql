begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users (id, email) values
  ('a0260000-0000-4000-8000-000000000001', 'quota-a@test.dev'),
  ('a0260000-0000-4000-8000-000000000002', 'quota-b@test.dev');
update public.resource_quota_limits set active_room_limit = 1, room_window_limit = 2, room_daily_limit = 3,
  search_window_limit = 2, search_daily_limit = 3, account_paid_daily_limit = 6,
  global_paid_daily_limit = 8, concurrent_search_limit = 1,
  paid_used = 0, paid_day = (now() at time zone 'UTC')::date;

select ok(not has_table_privilege('authenticated', 'public.account_resource_usage', 'SELECT'), 'clients cannot read account usage');
select ok(not has_table_privilege('authenticated', 'public.resource_quota_limits', 'UPDATE'), 'clients cannot increase budgets');
select ok(not has_function_privilege('authenticated', 'public.reserve_search_quota(uuid,uuid,integer)', 'EXECUTE'), 'clients cannot reserve or forge paid units');
select ok(not has_function_privilege('authenticated', 'public.release_search_quota(uuid)', 'EXECUTE'), 'clients cannot release other in-flight searches');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"a0260000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_ok($$select public.create_room('NaN', 121)$$, '22023', '無效的座標', 'NaN coordinates rejected');
select throws_ok($$select public.create_room(25, 'Infinity')$$, '22023', '無效的座標', 'infinite coordinates rejected');
select throws_ok($$select public.create_room(91, 121)$$, '22023', '無效的座標', 'out-of-range coordinates rejected');
select throws_ok($$select public.create_room(null, 121)$$, '22023', '無效的座標', 'null coordinates rejected');
create temp table quota_rooms (id uuid);
insert into quota_rooms values (public.create_room(25, 121));
select throws_ok($$select public.create_room(25, 121)$$, 'P0001', '建房額度已用完，請稍後再試', 'active rooms are capped');
reset role;
update public.rooms set created_at = now() - interval '25 hours' where id in (select id from quota_rooms);
set local role authenticated;
select lives_ok($$insert into quota_rooms values (public.create_room(25, 121))$$, 'expired lobby stops counting without deleting data');
reset role;
select is((select count(*)::integer from public.rooms where id in (select id from quota_rooms)), 2, 'expired room data survives');
-- Deleting rooms cannot refund creation counters.
delete from public.rooms where id in (select id from quota_rooms);
set local role authenticated;
select throws_ok($$select public.create_room(25, 121)$$, 'P0001', '建房額度已用完，請稍後再試', 'deletion does not bypass short creation window');
reset role;
update public.account_resource_usage set room_window = now() - interval '11 minutes';
set local role authenticated;
select lives_ok($$insert into quota_rooms values (public.create_room(25, 121))$$, 'creation window replenishes');
reset role;
delete from public.rooms where id in (select id from quota_rooms);
set local role authenticated;
select throws_ok($$select public.create_room(25, 121)$$, 'P0001', '建房額度已用完，請稍後再試', 'daily creation quota survives room deletion');
reset role;
update public.account_resource_usage set room_day = current_date - 1;
set local role authenticated;
select lives_ok($$insert into quota_rooms values (public.create_room(25, 121))$$, 'daily creation quota replenishes');
reset role;

create temp table quota_search_room as select id from public.rooms where id in (select id from quota_rooms);
create temp table quota_lease as select public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 2) as id;
select ok((select id is not null from quota_lease), 'first search reserves a durable lease');
select is(public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 2), null::uuid, 'same room is single-flight across replicas');
insert into public.rooms (id, host_id) values ('b0260000-0000-4000-8000-000000000002', 'a0260000-0000-4000-8000-000000000002');
select is(public.reserve_search_quota('a0260000-0000-4000-8000-000000000002', 'b0260000-0000-4000-8000-000000000002', 2), null::uuid, 'global concurrent search cap spans accounts');
select public.release_search_quota((select id from quota_lease));
select is((select paid_used from public.resource_quota_limits), 2, 'release never refunds a paid reservation');
update quota_lease set id = public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 2);
select ok((select id is not null from quota_lease), 'second search allowed');
select public.release_search_quota((select id from quota_lease));
select is(public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 0), null::uuid, 'search short-window quota counts failures and successes alike');
update public.account_resource_usage set search_window = now() - interval '11 minutes';
update quota_lease set id = public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 2);
select ok((select id is not null from quota_lease), 'search short window replenishes');
select public.release_search_quota((select id from quota_lease));
select is(public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 0), null::uuid, 'search daily quota enforced even for mock/free search');
update public.resource_quota_limits set search_daily_limit = 10;
select is(public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 1), null::uuid, 'per-account paid daily budget enforced');
update public.account_resource_usage set search_day = current_date - 1, search_window = now() - interval '11 minutes';
select is(public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 3), null::uuid, 'global paid budget does not reset with an account');
update quota_lease set id = public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), 2);
select ok((select id is not null from quota_lease), 'daily account reset allows reservation exactly at global limit');
select public.release_search_quota((select id from quota_lease));
select is(public.reserve_search_quota('a0260000-0000-4000-8000-000000000002', 'b0260000-0000-4000-8000-000000000002', 1), null::uuid, 'global paid budget spans accounts');
update public.resource_quota_limits set paid_day = current_date - 1;
update quota_lease set id = public.reserve_search_quota('a0260000-0000-4000-8000-000000000002', 'b0260000-0000-4000-8000-000000000002', 2);
select ok((select id is not null from quota_lease), 'global paid budget replenishes next day');
update public.search_quota_leases set expires_at = now() - interval '1 second';
update quota_lease set id = public.reserve_search_quota('a0260000-0000-4000-8000-000000000002', 'b0260000-0000-4000-8000-000000000002', 2);
select ok((select id is not null from quota_lease), 'crashed-worker lease expires');
delete from public.rooms where id = 'b0260000-0000-4000-8000-000000000002';
select is((select count(*)::integer from public.search_quota_leases), 1, 'room deletion cannot free in-flight capacity');
select public.release_search_quota((select id from quota_lease));
select is(public.reserve_search_quota('a0260000-0000-4000-8000-000000000002', (select id from quota_search_room), 0), null::uuid, 'non-host cannot reserve search for another room');
select throws_ok($$select public.reserve_search_quota('a0260000-0000-4000-8000-000000000001', (select id from quota_search_room), -1)$$, '22023', 'invalid paid request budget', 'negative paid units rejected');

select * from finish();
rollback;

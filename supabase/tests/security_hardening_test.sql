begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

-- 1 registered host, 1 anonymous guest, 1 pending-upgrade guest, 19 filler members.
insert into auth.users (id, email, is_anonymous) values
  ('c0270000-0000-4000-8000-000000000001', 'harden-host@test.dev', false),
  ('c0270000-0000-4000-8000-000000000002', null, true),
  ('c0270000-0000-4000-8000-000000000003', 'pending@example.org', false);
insert into public.guest_email_validations (user_id, email, phase, expires_at) values
  ('c0270000-0000-4000-8000-000000000003', 'pending@example.org', 'pending_confirmation', now() + interval '10 minutes');
insert into auth.users (id, email)
  select ('c0270000-0000-4000-8000-1000000000' || lpad(i::text, 2, '0'))::uuid, 'filler' || i || '@test.dev'
  from generate_series(1, 19) i;

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c0270000-0000-4000-8000-000000000001","role":"authenticated"}';
create temp table harden_room as select public.create_room(25, 121) as id;
reset role;

-- H1: an anonymous or pending guest who inherited the host seat cannot spend search quota.
update public.rooms set host_id = 'c0270000-0000-4000-8000-000000000002' where id = (select id from harden_room);
select throws_ok(
  $$select public.reserve_search_quota('c0270000-0000-4000-8000-000000000002', (select id from harden_room), 2)$$,
  'FB001', '訪客需完成註冊後才能搜尋', 'anonymous successor host cannot reserve paid search quota');
update public.rooms set host_id = 'c0270000-0000-4000-8000-000000000003' where id = (select id from harden_room);
select throws_ok(
  $$select public.reserve_search_quota('c0270000-0000-4000-8000-000000000003', (select id from harden_room), 2)$$,
  'FB001', '訪客需完成註冊後才能搜尋', 'pending-upgrade host cannot reserve paid search quota');
select is(
  public.reserve_search_quota('c0270000-0000-4000-8000-000000000002', (select id from harden_room), 2),
  null::uuid, 'non-host check still answers null before the identity check');
update public.rooms set host_id = 'c0270000-0000-4000-8000-000000000001' where id = (select id from harden_room);
select ok(
  public.reserve_search_quota('c0270000-0000-4000-8000-000000000001', (select id from harden_room), 2) is not null,
  'registered host keeps search behavior');
select ok(not has_function_privilege('authenticated', 'public.is_registered_account(uuid)', 'EXECUTE'),
  'clients cannot probe other accounts registration state');

-- M3: default_prefs is bounded.
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c0270000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok(
  $$update public.profiles set default_prefs = jsonb_build_object('x', repeat('a', 5000)) where id = auth.uid()$$,
  '23514', null, 'oversized default_prefs rejected');
select throws_ok(
  $$update public.profiles set default_prefs = '"scalar"'::jsonb where id = auth.uid()$$,
  '23514', null, 'non-object default_prefs rejected');
select lives_ok(
  $$update public.profiles set default_prefs = '{"cuisines":["japanese","taiwanese"],"dietary":["vegetarian"],"budget_max":500}' where id = auth.uid()$$,
  'normal default_prefs still writable');
reset role;

-- L2: room membership is capped at 20; existing members may still re-enter.
insert into public.room_members (room_id, user_id)
  select (select id from harden_room), ('c0270000-0000-4000-8000-1000000000' || lpad(i::text, 2, '0'))::uuid
  from generate_series(1, 19) i;
create temp table harden_code as select code from public.rooms where id = (select id from harden_room);
grant select on harden_code to authenticated;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c0270000-0000-4000-8000-000000000002","role":"authenticated"}';
select throws_ok($$select public.join_room((select code from harden_code))$$,
  'P0001', '房間人數已滿', '21st member is rejected');
set local "request.jwt.claims" = '{"sub":"c0270000-0000-4000-8000-100000000001","role":"authenticated"}';
select is(public.join_room((select code from harden_code)), (select id from harden_room),
  'existing member re-entry is not blocked by the cap');
reset role;

-- L8: dining_history exposes only rating for writes, regardless of the project's default ACL.
-- Invariant check only: local/CI default ACLs never grant table-level UPDATE, so these stay green
-- without the revoke. The revoke matters for projects created under the older grant-all defaults.
select ok(not has_column_privilege('authenticated', 'public.dining_history', 'restaurant_id', 'UPDATE'),
  'clients cannot rewrite dining_history.restaurant_id');
select ok(not has_column_privilege('authenticated', 'public.dining_history', 'decided_at', 'UPDATE'),
  'clients cannot rewrite dining_history.decided_at');
select ok(has_column_privilege('authenticated', 'public.dining_history', 'rating', 'UPDATE'),
  'rating stays writable');
select ok(not has_table_privilege('anon', 'public.dining_history', 'SELECT,INSERT,UPDATE,DELETE'),
  'anon has no dining_history privileges');

-- Guard depth: even if a column grant regresses, version columns stay system-only.
grant update (search_version, delete_version) on public.rooms to authenticated;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"c0270000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_like($$update public.rooms set search_version = search_version + 5 where id = (select id from harden_room)$$,
  '%僅系統可修改房間狀態欄位%', 'guard rejects client search_version writes');
select throws_like($$update public.rooms set delete_version = 999 where id = (select id from harden_room)$$,
  '%僅系統可修改房間狀態欄位%', 'guard rejects client delete_version writes');
reset role;

select * from finish();
rollback;

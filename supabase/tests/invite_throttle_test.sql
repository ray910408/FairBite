begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id,email,is_anonymous) values
  ('75400000-0000-4000-8000-000000000001','invite-host@test.dev',false),
  ('75400000-0000-4000-8000-000000000002',null,true),
  ('75400000-0000-4000-8000-000000000003','invite-member@test.dev',false);
insert into public.rooms(id,code,host_id,status) values
  ('75400000-0000-4000-8000-000000000011','I75401','75400000-0000-4000-8000-000000000001','lobby'),
  ('75400000-0000-4000-8000-000000000012','I75402','75400000-0000-4000-8000-000000000001','candidates');
insert into public.room_members(room_id,user_id) values
  ('75400000-0000-4000-8000-000000000012','75400000-0000-4000-8000-000000000003');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"75400000-0000-4000-8000-000000000002","role":"authenticated","is_anonymous":true}';
select is((select count(*) from public.resolve_room_invite('missing-invite'))::int,0,
  'invalid code returns no row without rolling back its attempt');
select results_eq($$select * from public.resolve_room_invite(' i75401 ')$$,
  $$values ('75400000-0000-4000-8000-000000000011'::uuid,'lobby'::text,false)$$,
  'anonymous authenticated user can resolve a normalized lobby code');
select is((select count(*) from public.resolve_room_invite('I75402'))::int,0,
  'nonmember cannot discover a started room');
reset role;
select is((select count(*) from public.join_attempts where user_id='75400000-0000-4000-8000-000000000002')::int,3,
  'valid, invalid and hidden invite resolutions all consume attempts');
select is((select count(*) from public.room_members where user_id='75400000-0000-4000-8000-000000000002')::int,0,
  'resolving does not join a room');

-- Eight resolve attempts plus a resolve/join pair consume the same ten-call budget.
set local role authenticated;
do $$begin
  for i in 1..5 loop perform public.resolve_room_invite('missing-invite'); end loop;
end$$;
select is((select room_id from public.resolve_room_invite('I75401')),
  '75400000-0000-4000-8000-000000000011'::uuid,'ninth attempt can resolve');
select is(public.join_room('I75401'),'75400000-0000-4000-8000-000000000011'::uuid,
  'tenth shared attempt can join after resolving');
select throws_ok($$select * from public.resolve_room_invite('I75401')$$,
  '嘗試過於頻繁，請稍後再試','valid lookup blocked at shared limit');
select throws_ok($$select * from public.resolve_room_invite('missing-invite')$$,
  '嘗試過於頻繁，請稍後再試','invalid lookup has the same limit error');
select throws_ok($$select public.join_room('I75401')$$,
  '嘗試過於頻繁，請稍後再試','resolve calls also exhaust join quota');
reset role;
select is((select count(*) from public.join_attempts where user_id='75400000-0000-4000-8000-000000000002')::int,10,
  'blocked attempts do not alter the full budget');

-- A different account has an independent budget and can resume a started room.
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"75400000-0000-4000-8000-000000000003","role":"authenticated"}';
select results_eq($$select * from public.resolve_room_invite('I75402')$$,
  $$values ('75400000-0000-4000-8000-000000000012'::uuid,'candidates'::text,true)$$,
  'member can resume a started room with independent quota');
do $$begin
  for i in 1..9 loop perform public.join_room('missing-invite'); end loop;
end$$;
select throws_ok($$select * from public.resolve_room_invite('I75402')$$,
  '嘗試過於頻繁，請稍後再試','join calls also exhaust resolver quota');
reset role;
update public.join_attempts set attempted_at=now()-interval '2 minutes'
  where user_id='75400000-0000-4000-8000-000000000003';
set local role authenticated;
select is((select count(*) from public.resolve_room_invite('I75402'))::int,1,
  'attempts outside the one-minute window allow lookup again');

set local "request.jwt.claims" = '{}';
select throws_ok($$select * from public.resolve_room_invite('I75401')$$,'未登入',
  'missing identity rejected before lookup');
reset role;
select ok(not has_function_privilege('anon','public.resolve_room_invite(text)','EXECUTE'),
  'unauthenticated role cannot execute resolver');
select ok(has_function_privilege('authenticated','public.resolve_room_invite(text)','EXECUTE'),
  'authenticated role retains resolver access');
select * from finish();
rollback;

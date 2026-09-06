begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id,email) values
 ('10000000-0000-0000-0000-000000000001','security-a@test.dev'),
 ('10000000-0000-0000-0000-000000000002','security-b@test.dev');
insert into rooms(id,host_id) values
 ('10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000001');
insert into room_members(room_id,user_id) values
 ('10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000001'),
 ('10000000-0000-0000-0000-000000000010','10000000-0000-0000-0000-000000000002');
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"10000000-0000-0000-0000-000000000001","role":"authenticated"}';
select throws_like($$update profiles set display_name=repeat('x',81) where id=auth.uid()$$,
 '%profiles_display_name_bounds%', 'oversized name rejected');
select throws_like($$update profiles set display_name='   ' where id=auth.uid()$$,
 '%profiles_display_name_bounds%', 'blank name rejected');
select lives_ok($$update profiles set display_name=repeat('名',80) where id=auth.uid()$$,
 '80 character multilingual name accepted');
select throws_like($$update room_members set cuisines=(select jsonb_agg('japanese'::text) from generate_series(1,21)) where user_id=auth.uid()$$,
 '%room_members_cuisines_bounds%', 'oversized array rejected');
select throws_like($$update room_members set cuisines='["japanese","japanese"]' where user_id=auth.uid()$$,
 '%room_members_cuisines_bounds%', 'duplicate cuisine rejected');
select throws_like($$update room_members set cuisines='["unknown"]' where user_id=auth.uid()$$,
 '%room_members_cuisines_bounds%', 'unknown cuisine rejected');
select throws_like($$update room_members set cuisines=jsonb_build_array(repeat('x',65)) where user_id=auth.uid()$$,
 '%room_members_cuisines_bounds%', 'long element rejected');
select throws_like($$update room_members set dietary='["unknown"]' where user_id=auth.uid()$$,
 '%room_members_dietary_bounds%', 'unknown dietary rejected');
select lives_ok($$update room_members set cuisines='["japanese","taiwanese"]',dietary='["vegetarian"]',ready=true where user_id=auth.uid()$$,
 'normal preferences and ready remain writable');
select throws_like($$update room_members set joined_at='1900-01-01' where user_id=auth.uid()$$,
 '%permission denied%', 'joined_at is server owned');
select throws_like($$update room_members set room_id=room_id where user_id=auth.uid()$$,
 '%permission denied%', 'membership identity is server owned');
select throws_like($$select default_prefs from profiles$$, '%permission denied%', 'private column cannot be read directly');
select lives_ok($$update profiles set default_prefs='{"cuisines":["japanese"]}' where id=auth.uid()$$,
 'owner can update preferences');
select is((select default_prefs from get_my_default_prefs()), '{"cuisines":["japanese"]}'::jsonb,
 'owner RPC returns own preferences');
set local "request.jwt.claims" = '{"sub":"10000000-0000-0000-0000-000000000002","role":"authenticated"}';
select is((select default_prefs from get_my_default_prefs()), '{}'::jsonb, 'RPC cannot select another member');
select is((select count(display_name) from profiles)::int, 2, 'same-room public identity remains readable');
select throws_like($$select * from profiles$$,'%permission denied%', 'wildcard cannot expose private preferences');
reset role;
set local role anon;
select throws_like($$select * from get_my_default_prefs()$$,'%permission denied%', 'anonymous cannot call prefs RPC');
reset role;
select throws_like($$insert into auth.users(id,email,raw_user_meta_data) values
 ('10000000-0000-0000-0000-000000000003','security-c@test.dev',jsonb_build_object('display_name',repeat('x',81)))$$,
 '%profiles_display_name_bounds%', 'signup metadata cannot bypass name bound');
select * from finish();
rollback;

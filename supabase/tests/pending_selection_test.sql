begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id,email) values
 ('75100000-0000-4000-8000-000000000001','pending-rls@test.dev'),
 ('75100000-0000-4000-8000-000000000002','pending-outsider@test.dev');
insert into rooms(id,host_id,status,draw_version) values
 ('75100000-0000-4000-8000-000000000010','75100000-0000-4000-8000-000000000001','pending',2);
insert into room_members(room_id,user_id) values
 ('75100000-0000-4000-8000-000000000010','75100000-0000-4000-8000-000000000001');
insert into restaurants(id,place_id,name,lat,lng,source) values
 ('75100000-0000-4000-8000-000000000020','pending-rls-place','test',25,121,'mock');
insert into room_candidates(room_id,restaurant_id,status,probability,batch_excluded) values
 ('75100000-0000-4000-8000-000000000010','75100000-0000-4000-8000-000000000020','excluded',null,true);
insert into draws(room_id,version,seed,winner_restaurant_id,probabilities) values
 ('75100000-0000-4000-8000-000000000010',1,'seed-1','75100000-0000-4000-8000-000000000020','{}'),
 ('75100000-0000-4000-8000-000000000010',2,'seed-2','75100000-0000-4000-8000-000000000020','{}');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"75100000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select draw_version from rooms where id='75100000-0000-4000-8000-000000000010'),2::bigint,
 'member can read current draw version without room center access');
select is((select count(*) from draws where room_id='75100000-0000-4000-8000-000000000010')::int,2,
 'member can read immutable draw audit snapshots');
select throws_like($$update rooms set draw_version=3 where id='75100000-0000-4000-8000-000000000010'$$,
 '%permission denied%', 'client cannot advance draw version');
select throws_like($$update room_candidates set batch_excluded=false where room_id='75100000-0000-4000-8000-000000000010'$$,
 '%permission denied%', 'client cannot revive a batch exclusion');
select throws_like($$select center_lat from rooms$$,'%permission denied%',
 'adding draw version did not expose the private room center');

set local "request.jwt.claims" = '{"sub":"75100000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*) from draws)::int,0,'non-member cannot read draw audit snapshots');
select * from finish();
rollback;

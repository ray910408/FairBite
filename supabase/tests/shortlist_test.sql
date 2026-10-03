begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id,email) values
 ('75500000-0000-4000-8000-000000000001','shortlist-member@test.dev'),
 ('75500000-0000-4000-8000-000000000002','shortlist-outsider@test.dev');
select lives_ok($$insert into rooms(id,host_id,status,center_lat,center_lng) values
 ('75500000-0000-4000-8000-000000000010','75500000-0000-4000-8000-000000000001','shortlisting',25,121)$$,
 'shortlisting is a valid room status');
insert into room_members(room_id,user_id) values
 ('75500000-0000-4000-8000-000000000010','75500000-0000-4000-8000-000000000001');
insert into restaurants(id,place_id,name,lat,lng,source) values
 ('75500000-0000-4000-8000-000000000020','shortlist-rls-place','test',25,121,'mock');
insert into room_candidates(room_id,restaurant_id,status,probability,shortlist_excluded) values
 ('75500000-0000-4000-8000-000000000010','75500000-0000-4000-8000-000000000020','excluded',null,true);
insert into shortlist_votes(room_id,user_id) values
 ('75500000-0000-4000-8000-000000000010','75500000-0000-4000-8000-000000000001');
insert into shortlist_picks(room_id,user_id,restaurant_id) values
 ('75500000-0000-4000-8000-000000000010','75500000-0000-4000-8000-000000000001','75500000-0000-4000-8000-000000000020');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"75500000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from shortlist_votes)::int,1,'members can read the shortlist vote tally');
select is((select count(*) from shortlist_picks)::int,1,'members can read picks');
select throws_like($$insert into shortlist_votes(room_id,user_id) values
 ('75500000-0000-4000-8000-000000000010','75500000-0000-4000-8000-000000000001')$$,
 '%permission denied%','client cannot bypass the shortlist vote command');
select throws_like($$delete from shortlist_votes$$,'%permission denied%','client cannot delete shortlist votes');
select throws_like($$insert into shortlist_picks(room_id,user_id,restaurant_id) values
 ('75500000-0000-4000-8000-000000000010','75500000-0000-4000-8000-000000000001','75500000-0000-4000-8000-000000000020')$$,
 '%permission denied%','client cannot bypass the pick command');
select throws_like($$delete from shortlist_picks$$,'%permission denied%','client cannot delete picks');
select throws_like($$update room_candidates set shortlist_excluded=false
 where room_id='75500000-0000-4000-8000-000000000010'$$,
 '%permission denied%','client cannot revive a shortlist exclusion');

set local "request.jwt.claims" = '{"sub":"75500000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*) from shortlist_votes)::int,0,'outsiders cannot read shortlist votes');
select is((select count(*) from shortlist_picks)::int,0,'outsiders cannot read picks');
reset role;

update rooms set status='lobby' where id='75500000-0000-4000-8000-000000000010';
select is((select count(*) from shortlist_votes where room_id='75500000-0000-4000-8000-000000000010')::int,0,
 'returning to preparation clears shortlist votes');
select is((select count(*) from shortlist_picks where room_id='75500000-0000-4000-8000-000000000010')::int,0,
 'returning to preparation clears picks');
select * from finish();
rollback;

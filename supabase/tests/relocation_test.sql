begin;
create extension if not exists pgtap with schema extensions;
select no_plan();
insert into auth.users(id,email) values
 ('75200000-0000-4000-8000-000000000001','relocation-member@test.dev'),
 ('75200000-0000-4000-8000-000000000002','relocation-outsider@test.dev');
insert into rooms(id,host_id,status,center_lat,center_lng) values
 ('75200000-0000-4000-8000-000000000010','75200000-0000-4000-8000-000000000001','voting',25,121);
insert into room_members(room_id,user_id) values
 ('75200000-0000-4000-8000-000000000010','75200000-0000-4000-8000-000000000001');
insert into location_change_votes(room_id,user_id) values
 ('75200000-0000-4000-8000-000000000010','75200000-0000-4000-8000-000000000001');
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"75200000-0000-4000-8000-000000000001","role":"authenticated"}';
select is((select count(*) from location_change_votes)::int,1,'members can read location tally');
select is((select search_version from rooms where id='75200000-0000-4000-8000-000000000010'),0::bigint,'member can read round version');
select throws_like($$delete from location_change_votes$$,'%permission denied%','client cannot bypass the voting command');
select throws_like($$update rooms set search_version=12$$,'%permission denied%','client cannot alter search generation');
select throws_like($$select center_lat from rooms$$,'%permission denied%','room center remains private');
set local "request.jwt.claims" = '{"sub":"75200000-0000-4000-8000-000000000002","role":"authenticated"}';
select is((select count(*) from location_change_votes)::int,0,'outsiders cannot read votes');
reset role;
update rooms set status='lobby' where id='75200000-0000-4000-8000-000000000010';
select is((select count(*) from location_change_votes)::int,0,'returning to preparation clears old location votes');
select is((select search_version from rooms where id='75200000-0000-4000-8000-000000000010'),1::bigint,'same-center return invalidates previous search round');
select * from finish();
rollback;

begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

select is((select pubdelete from pg_publication where pubname = 'supabase_realtime'), false,
 'realtime never publishes DELETE: apply_rls skips RLS for deletes');
-- regclass 依賴 nspname，才只會在 pg_class⋈pg_namespace 之後求值；寫死 'public.%I' 時 cast
-- 只依賴 relname，planner 曾在 join 前對 auth.instances 求值而報 relation "public.instances" does not exist
select is_empty($$
  select p.tablename::text from pg_publication_tables p
  where p.pubname = 'supabase_realtime' and p.schemaname = 'public'
    and exists (select 1 from pg_attribute a
                where a.attrelid = format('%I.%I', p.schemaname, p.tablename)::regclass
                  and a.attname = 'room_id' and not a.attisdropped)
    and not exists (select 1 from pg_trigger t
                    where t.tgrelid = format('%I.%I', p.schemaname, p.tablename)::regclass
                      and t.tgfoid = 'public.signal_room_delete'::regproc
                      and t.tgenabled <> 'D' and t.tgoldtable is not null
                      and (t.tgtype & 8) <> 0 and (t.tgtype & 1) = 0)
$$, 'every published room-scoped table signals its deletes through rooms');

insert into auth.users(id,email) values
 ('76600000-0000-4000-8000-000000000001','rt-delete-a@test.dev'),
 ('76600000-0000-4000-8000-000000000002','rt-delete-b@test.dev');
insert into rooms(id,host_id,status,center_lat,center_lng) values
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000001','shortlisting',25,121);
insert into room_members(room_id,user_id) values
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000001'),
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000002');
insert into restaurants(id,place_id,name,lat,lng,source) values
 ('76600000-0000-4000-8000-000000000020','rt-delete-place','test',25,121,'mock');
insert into room_candidates(room_id,restaurant_id,status,probability) values
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000020','kept',1);
insert into votes(room_id,user_id,restaurant_id,kind) values
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000001','76600000-0000-4000-8000-000000000020','up'),
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000002','76600000-0000-4000-8000-000000000020','up');
insert into shortlist_votes(room_id,user_id) values
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000001');
insert into shortlist_picks(room_id,user_id,restaurant_id) values
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000001','76600000-0000-4000-8000-000000000020');

delete from votes where room_id = '76600000-0000-4000-8000-000000000010';
select is((select delete_version from rooms where id = '76600000-0000-4000-8000-000000000010'), 1::bigint,
 'a multi-row delete bumps the room once per statement');

select lives_ok($$update rooms set status = 'lobby' where id = '76600000-0000-4000-8000-000000000010'$$,
 'rooms update that clears shortlist rows in its BEFORE trigger does not trip on its own row');
select is((select count(*) from shortlist_picks where room_id = '76600000-0000-4000-8000-000000000010')::int, 0,
 'the nested clear still happened');

insert into shortlist_votes(room_id,user_id) values
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000002');
select lives_ok($$delete from room_members where room_id = '76600000-0000-4000-8000-000000000010'
  and user_id = '76600000-0000-4000-8000-000000000002'$$,
 'leaving cascades into shortlist rows, whose signal fires at depth 1 without tripping');
select ok((select delete_version from rooms where id = '76600000-0000-4000-8000-000000000010') > 1,
 'leaving the room signals the remaining members');

insert into auth.users(id,email) values ('76600000-0000-4000-8000-000000000003','rt-delete-c@test.dev');
insert into room_members(room_id,user_id) values
 ('76600000-0000-4000-8000-000000000010','76600000-0000-4000-8000-000000000003');
update rooms set delete_version = 0 where id = '76600000-0000-4000-8000-000000000010';
delete from auth.users where id = '76600000-0000-4000-8000-000000000003';
select ok((select delete_version from rooms where id = '76600000-0000-4000-8000-000000000010') > 0,
 'account deletion cascading auth.users -> profiles -> room_members still signals the room');

select lives_ok($$delete from rooms where id = '76600000-0000-4000-8000-000000000010'$$,
 'deleting the room cascades into a no-op signal on the vanished row');
select * from finish();
rollback;

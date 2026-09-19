begin;
create extension if not exists pgtap with schema extensions;
select no_plan();

insert into auth.users(id,email,is_anonymous) values
  ('75300000-0000-4000-8000-000000000001',null,true),
  ('75300000-0000-4000-8000-000000000002','existing@test.dev',false);
insert into public.guest_email_validations(user_id,email,phase,expires_at) values
  ('75300000-0000-4000-8000-000000000001','guest@example.org','validated',now() + interval '10 minutes');

select throws_like(
  $$update auth.users set email_change='other@example.org' where id='75300000-0000-4000-8000-000000000001'$$,
  '%upgrade_email_not_validated%',
  'guest cannot link an email other than the exact server-authorized address'
);
update auth.users set email_change='guest@example.org'
  where id='75300000-0000-4000-8000-000000000001';
select is(
  (select phase from public.guest_email_validations where user_id='75300000-0000-4000-8000-000000000001'),
  'pending_confirmation',
  'exact authorized email advances to pending confirmation'
);
-- Match Supabase Auth's two separate writes, rather than merging them.
update auth.users set is_anonymous=false
  where id='75300000-0000-4000-8000-000000000001';
select is(
  (select phase from public.guest_email_validations where user_id='75300000-0000-4000-8000-000000000001'),
  'pending_confirmation',
  'clearing anonymous flag alone does not complete email verification'
);
select throws_like(
  $$update auth.users set email='other@example.org' where id='75300000-0000-4000-8000-000000000001'$$,
  '%upgrade_email_confirmation_not_validated%',
  'pending upgrade still rejects a different email after anonymous flag clears'
);
update auth.users set email='guest@example.org', email_change='', email_confirmed_at=now()
  where id='75300000-0000-4000-8000-000000000001';
select is(
  (select phase from public.guest_email_validations where user_id='75300000-0000-4000-8000-000000000001'),
  'confirmed',
  'confirmation of the same email completes the authorization ticket'
);

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"75300000-0000-4000-8000-000000000001","role":"authenticated"}';
select throws_like(
  $$select public.create_room(25,121)$$,
  '%訪客需完成註冊後才能建立房間%',
  'upgraded guest still needs a password before creating rooms'
);
select throws_like(
  $$select * from public.guest_email_validations$$,
  '%permission denied%',
  'clients cannot read email authorization tickets'
);

reset role;
update auth.users set encrypted_password='test-only-password-hash'
  where id='75300000-0000-4000-8000-000000000001';
set local role authenticated;
select lives_ok(
  $$select public.create_room(25,121)$$,
  'verified upgrade with password can create rooms'
);

set local "request.jwt.claims" = '{"sub":"75300000-0000-4000-8000-000000000002","role":"authenticated"}';
select lives_ok(
  $$select public.create_room(25,121)$$,
  'preexisting registered accounts retain create-room behavior'
);

select * from finish();
rollback;

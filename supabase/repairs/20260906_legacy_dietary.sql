-- Explicitly approved data repair, not an automatic migration.
-- Preflight confirmed one legacy ["no_pork"] row. This retired option is already
-- neutral in Evaluate; never remove vegetarian or arbitrary unknown choices.
-- One DO statement makes backup + update atomic even through the Management API.
do $$
begin
  perform set_config('lock_timeout', '5s', true);
  lock table public.room_members in share row exclusive mode;
  if (select count(*) from public.room_members where dietary = '["no_pork"]') > 1 then
    raise exception 'Legacy dietary data changed: inspect before repairing more than one row';
  end if;

  create schema if not exists private_member_repairs;
  revoke all on schema private_member_repairs from public, anon, authenticated, service_role;
  create table if not exists private_member_repairs.dietary_20260906 (
    room_id uuid not null,
    user_id uuid not null,
    original_dietary jsonb not null,
    repaired_dietary jsonb not null,
    backed_up_at timestamptz not null default now(),
    primary key (room_id, user_id)
  );
  alter table private_member_repairs.dietary_20260906 enable row level security;
  revoke all on private_member_repairs.dietary_20260906 from public, anon, authenticated, service_role;

  insert into private_member_repairs.dietary_20260906
    (room_id, user_id, original_dietary, repaired_dietary)
  select room_id, user_id, dietary, '[]'::jsonb
  from public.room_members where dietary = '["no_pork"]'
  on conflict (room_id, user_id) do nothing;

  update public.room_members m set dietary = b.repaired_dietary
  from private_member_repairs.dietary_20260906 b
  where m.room_id = b.room_id and m.user_id = b.user_id
    and m.dietary = '["no_pork"]' and b.original_dietary = m.dietary
    and b.repaired_dietary = '[]';
end $$;

-- A pending guest may correct a mistyped address after GoTrue has already
-- cleared is_anonymous. Keep guarding the newly server-validated address.
create or replace function public.guard_guest_email_upgrade()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  v_email text;
  v_phase text;
  v_expires timestamptz;
begin
  if not coalesce(old.is_anonymous, false) and not exists (
    select 1 from public.guest_email_validations
      where user_id = old.id and phase in ('validated', 'pending_confirmation')
  ) then return new; end if;

  if nullif(btrim(new.email_change), '') is not null
     and nullif(btrim(new.email_change), '') is distinct from nullif(btrim(old.email_change), '') then
    v_email := lower(btrim(new.email_change));
    select phase, expires_at into v_phase, v_expires
      from public.guest_email_validations
      where user_id = old.id and email = v_email for update;
    if v_phase is distinct from 'validated' or v_expires <= now() then
      raise exception 'upgrade_email_not_validated' using errcode = 'P0001';
    end if;
    update public.guest_email_validations
      set phase = 'pending_confirmation', updated_at = now()
      where user_id = old.id;
  elsif lower(coalesce(new.email, '')) is distinct from lower(coalesce(old.email, '')) then
    v_email := lower(btrim(new.email));
    select phase, expires_at into v_phase, v_expires
      from public.guest_email_validations
      where user_id = old.id and email = v_email for update;
    if v_phase is distinct from 'pending_confirmation' then
      raise exception 'upgrade_email_confirmation_not_validated' using errcode = 'P0001';
    end if;
    update public.guest_email_validations
      set phase = 'confirmed', updated_at = now()
      where user_id = old.id;
  end if;
  return new;
end $$;

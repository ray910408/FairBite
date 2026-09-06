-- Enforce bounds at the direct PostgREST write boundary, not only in the UI.
-- Deliberately validate existing data: invalid legacy rows block deployment for
-- explicit correction instead of silently discarding names or dietary choices.
create function public.valid_member_choices(j jsonb, allowed text[], max_items int)
returns boolean language plpgsql immutable set search_path = public as $$
begin
  if j is null or jsonb_typeof(j) <> 'array' then return false; end if;
  if octet_length(j::text) > 2048 or jsonb_array_length(j) > max_items then return false; end if;
  return not exists (
    select 1 from jsonb_array_elements(j) e
    where jsonb_typeof(e) <> 'string' or octet_length(e #>> '{}') > 64
       or not ((e #>> '{}') = any(allowed))
  ) and (select count(*) = count(distinct e) from jsonb_array_elements(j) e);
end $$;

alter table public.room_members
  add constraint room_members_cuisines_bounds check (public.valid_member_choices(cuisines,
    array['taiwanese','japanese','korean','cantonese','western','fast_food','indian',
          'hotpot','seafood','ramen','dessert','light_meal','breakfast'],20)),
  add constraint room_members_dietary_bounds check (public.valid_member_choices(dietary,array['vegetarian'],10));

alter table public.profiles add constraint profiles_display_name_bounds
  check (char_length(btrim(display_name)) between 1 and 80
         and char_length(display_name) <= 80 and octet_length(display_name) <= 320);

-- Missing metadata still supports email/anonymous signup. Explicit invalid names
-- fail the same CHECK as a direct profile update rather than being truncated.
create or replace function public.handle_new_user()
returns trigger language plpgsql security definer set search_path = public as $$
begin
  insert into profiles(id,display_name)
  values (new.id,coalesce(new.raw_user_meta_data->>'display_name',
    nullif(split_part(new.email,'@',1),''),'食客'));
  return new;
end $$;

revoke update on public.room_members from authenticated;
grant update (budget_max,cuisines,dietary,max_distance_m,transport,ready)
  on public.room_members to authenticated;

-- Preserve profiles(display_name) relationship embeds; private prefs are only
-- exposed through an argument-free, caller-bound function.
revoke select,update on public.profiles from authenticated;
grant select (id,display_name,created_at) on public.profiles to authenticated;
grant update (display_name,default_prefs) on public.profiles to authenticated;
create function public.get_my_default_prefs()
returns table(default_prefs jsonb) language sql stable security definer
set search_path = public as $$
  select p.default_prefs from profiles p where p.id = auth.uid();
$$;
revoke execute on function public.get_my_default_prefs() from public,anon;
grant execute on function public.get_my_default_prefs() to authenticated;

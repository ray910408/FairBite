-- 元素型別硬化（eng review D5）：既有 CHECK 只驗 jsonb_typeof = 'array' 不驗元素型別；
-- Go LoadMembers 對 [1,2] json.Unmarshal 會 error → 全房 search/vote/draw 500。
-- PostgREST 直寫路徑今天就踩得到。DB 層 CHECK 一次堵所有現在與未來的寫入路徑。
create or replace function public.jsonb_is_string_array(j jsonb)
returns boolean language sql immutable as $$
  select jsonb_typeof(j) = 'array'
     and not exists (select 1 from jsonb_array_elements(j) e where jsonb_typeof(e) <> 'string')
$$;
alter table public.room_members
  add constraint room_members_cuisines_strings check (public.jsonb_is_string_array(cuisines)),
  add constraint room_members_dietary_strings  check (public.jsonb_is_string_array(dietary));

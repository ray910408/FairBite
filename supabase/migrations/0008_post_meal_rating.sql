-- P3：餐後評分（spec §5 滿足度）。評分是「自己的列自己寫」的簡單寫入，
-- 走 Supabase 直寫 + RLS（spec §3 分工原則）；欄級 grant 只開 rating，
-- 其餘欄位仍僅 service role 可寫。rating 的 1–5 CHECK 已在 0003 建表時就位。
grant update (rating) on public.dining_history to authenticated;
create policy dining_history_update_rating on public.dining_history
  for update to authenticated
  using (user_id = auth.uid()) with check (user_id = auth.uid());

-- 評分偏好（CONTEXT.md 條件）：成員各自用滑桿選期望的 Google 評分 0.0–5.0，0 = 不在意。
-- 伺服器取有設定者的平均當基準，候選評分高於基準加權、低於降權（engine.go ratingFactor）。
-- 一位小數存 numeric，前端顯示與引擎比較同一個值；範圍在 DB 寫入邊界把關。
alter table public.room_members
  add column rating_pref numeric(2,1) not null default 0,
  add constraint room_members_rating_pref_bounds check (rating_pref between 0 and 5);

-- 同其他條件欄：成員可直接改自己的列（members_update RLS 限 lobby），其餘欄位仍不開放
grant update (rating_pref) on public.room_members to authenticated;

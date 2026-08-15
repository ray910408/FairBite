-- ADR-0007 退房制前置：刪房 cascade 掉 room_candidates 後，足跡頁/偏好學習/補評提示
-- 的 restaurants embed 會整批降級。補「自己同席紀錄中的餐廳可讀」條款——restaurants
-- 列永不實刪（tombstone 僅回撥 fetched_at）、dining_history.restaurant_id FK 為
-- RESTRICT，條款永久有效，不需快照欄位。
drop policy restaurants_select on public.restaurants;
create policy restaurants_select on public.restaurants for select to authenticated
  using (
    exists (select 1 from room_candidates rc
            where rc.restaurant_id = restaurants.id and is_room_member(rc.room_id))
    or exists (select 1 from dining_history dh
               where dh.restaurant_id = restaurants.id and dh.user_id = auth.uid())
  );

-- 足跡頁排序索引（TODOS 自註「下次動 dining_history schema 時順手補」）：
-- /history 查詢形狀是 user_id 過濾＋decided_at 排序，既有 recency 索引中欄卡住用不上。
create index dining_history_user_recency
  on public.dining_history (user_id, decided_at desc);

-- 退房查詢索引（eng review D14）：/api/leave 以 user_id 撈 membership，
-- PK (room_id, user_id) 前導欄不符走不到；表自清恆小屬預防性，一行順手。
create index room_members_by_user
  on public.room_members (user_id);

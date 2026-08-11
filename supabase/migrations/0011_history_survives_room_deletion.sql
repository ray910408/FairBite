-- ADR-0002：紀錄跟人。未來的房間清理/保留政策刪房時，不得抹掉成員同席紀錄
-- （TODOS 2026-08-06 遞延項）。unique(room_id, user_id) 在 room_id 為 null 時
-- 不再約束（Postgres 視 null 各異），但 null 只出現在刪房之後，
-- RecordDecision 的 on conflict 衝突鍵仍有效。
alter table public.dining_history alter column room_id drop not null;
alter table public.dining_history drop constraint dining_history_room_id_fkey;
alter table public.dining_history
  add constraint dining_history_room_id_fkey
  foreign key (room_id) references public.rooms(id) on delete set null;

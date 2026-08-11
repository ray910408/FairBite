-- arch c3：排除 kind 隨列持久化——exclusion_reason 回歸純顯示，
-- 死路判定（client）與伺服器一致改用結構化 kinds。
-- 舊列不回填：一次性房間（ADR-0004）已 decided 者不再判死路，
-- voting 中的房下一次 vote/draw rescore 會整批重寫。
alter table public.room_candidates
  add column exclusion_kinds text[] not null default '{}';

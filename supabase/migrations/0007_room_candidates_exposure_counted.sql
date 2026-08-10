-- P3 batch1（PR #4 fix round 2）：「本房 search 當下真正計入曝光（RecordExposure）」的
-- 不可變旗標。rescore 會重寫 status，但這個歷史事實不會變——ExposureBaseline 必須讀這個。
alter table public.room_candidates
  add column exposure_counted boolean not null default false;

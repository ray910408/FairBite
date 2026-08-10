-- P3 batch1（PR #4 fix round 2）：「本房 search 當下真正計入曝光（RecordExposure）」的
-- 不可變旗標。rescore 會重寫 status，但這個歷史事實不會變——ExposureBaseline 必須讀這個。
alter table public.room_candidates
  add column exposure_counted boolean not null default false;

-- Backfill（PR #4 Codex P2）：provenance 只在尚未 rescore 的房間可知——
-- status='candidates' 的房 rc.status 仍等於 search 當下事實，kept 即拿過 +1。
-- voting 房的 status 可能已被 rescore 重寫，kept→true 會誤標 search 時被排除者
--（重新引入剛修掉的歷史抹除），維持 false：最壞只是少給新店加成，部署後新房自癒。
update public.room_candidates rc
  set exposure_counted = true
  from public.rooms r
  where r.id = rc.room_id
    and r.status = 'candidates'
    and rc.status = 'kept';

-- arch c3：排除 kind 隨列持久化——exclusion_reason 回歸純顯示，
-- 死路判定（client）與伺服器一致改用結構化 kinds。
-- 舊列必須回填：voting 中候選全遭否決的房，部署後 client 會顯示「候選已全數失效」
-- 而非否決橫幅，且抽選鈕在沒有 kept 候選時是 disabled——能重寫這些列的 rescore
-- 永遠觸發不到，自癒對最需要自癒的房間恰好不成立。
alter table public.room_candidates
  add column exclusion_kinds text[] not null default '{}';

-- 依現存否決票回填：status='excluded' 且該成員否決仍在 → kinds 含 veto。
-- 只回填 veto——它是唯一被 client 當控制流讀取的 kind（deadEnd.ts）；
-- 其餘 kind 純顯示，rescore 時整批重寫即可。
update public.room_candidates rc
set exclusion_kinds = array['veto']
where rc.status = 'excluded'
  and exists (
    select 1 from public.votes v
    where v.room_id = rc.room_id and v.restaurant_id = rc.restaurant_id and v.kind = 'veto'
  );

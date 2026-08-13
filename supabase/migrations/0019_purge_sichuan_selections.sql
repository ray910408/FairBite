-- sichuan 選項已於 0018 輪自選單移除，但既存列仍可能殘留：
-- room_members.cuisines 讓 ConditionsForm 整列回寫時把隱形值寫回、
-- 拖累該成員滿足度 EMA（永無 pref hit）；profiles.default_prefs 由讀端過濾擋住
-- 帶入但值仍在。一次性出清，冪等。
update public.room_members
set cuisines = cuisines - 'sichuan'
where cuisines @> '["sichuan"]'::jsonb;

update public.profiles
set default_prefs = jsonb_set(default_prefs, '{cuisines}',
  (default_prefs->'cuisines') - 'sichuan')
where default_prefs->'cuisines' @> '["sichuan"]'::jsonb;

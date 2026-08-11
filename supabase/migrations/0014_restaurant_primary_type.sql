-- 快取必須持久化 Google primaryType，fallback 才能重用同一份正面表列判準。
-- 既有列刻意維持 NULL，由 Go 端 fail-closed；成功重搜後才會補回資格資料。
alter table public.restaurants add column primary_type text;

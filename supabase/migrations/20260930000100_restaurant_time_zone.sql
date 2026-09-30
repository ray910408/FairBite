-- 餐廳所在時區（Places timeZone.id，IANA，例如 'Asia/Tokyo'）：營業、快打烊、時段
-- 以餐廳當地時鐘判定。NULL = 未知（升級前的快取列），Go 端沿用 APP_TZ；下次搜尋 upsert 補上。
-- restaurants 維持 0001 的 table-level SELECT grant（RLS 篩列），新欄不需另行授權。
alter table public.restaurants add column time_zone text;

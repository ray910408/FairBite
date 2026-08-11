-- arch c7：provenance 入庫——「mock- 前綴 = 出身」的散裝知識收斂為逐列資料。
-- 既有列依 place_id 前綴回填（歷史上只有 mock 與 google 兩個 provider 寫入過）。
-- 刻意保留 default（原案為 drop default 強迫每個寫入點表態）：直接 SQL 寫入點
-- 共 13 處測試 fixture，逐一補 source 的 churn 不成比例；程式路徑的 provenance
-- 已由 UpsertRestaurants 的 source 參數在編譯期強制表態（server/db.go）。
alter table public.restaurants add column source text not null default 'google';
update public.restaurants set source = 'mock' where place_id like 'mock-%';

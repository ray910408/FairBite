-- arch c7：provenance 入庫——「mock- 前綴 = 出身」的散裝知識收斂為逐列資料。
-- 既有列依 place_id 前綴回填（歷史上只有 mock 與 google 兩個 provider 寫入過）。
alter table public.restaurants add column source text not null default 'google';
update public.restaurants set source = 'mock' where place_id like 'mock-%';
-- 回填後 drop default：provenance 不能 fail open——未指定 source 的寫入應該在
-- 編譯期／執行期失敗，而不是被靜默標成 google（第三個 provider 進來時尤其致命）。
alter table public.restaurants alter column source drop default;

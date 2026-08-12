begin;
create extension if not exists pgtap with schema extensions;
select plan(62);

-- 回歸鎖：authenticated 對 public 表的 grant 矩陣必須精確等於預期矩陣。
-- create_room/join_room 是唯一合法寫入入口；這條 pin 住的就是那個前提——
-- 誰若把某表的 grant 改寬成含 insert/delete，這裡就會紅（不用等有人真的繞過 RPC 才發現）。
select results_eq(
  $$
    select table_name::text collate "default", privilege_type::text collate "default"
    from information_schema.role_table_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and privilege_type in ('SELECT','INSERT','UPDATE','DELETE')
    order by 1, 2
  $$,
  $$
    values
      ('dining_history','SELECT'),
      ('draws','SELECT'),
      ('exposure_stats','SELECT'),
      ('profiles','SELECT'), ('profiles','UPDATE'),
      ('restaurants','SELECT'),
      ('room_candidates','SELECT'),
      ('room_members','SELECT'), ('room_members','UPDATE'),
      -- rooms 兩種權限都已是欄級（SELECT 見 0015、UPDATE 見 0003），
      -- 欄級 grant 不會出現在 role_table_grants，改由下面兩條 role_column_grants 釘住
      ('votes','SELECT')
    order by 1, 2
  $$,
  'authenticated 的 table grant 矩陣精確等於預期（多/少/換一條即紅，擋 insert/delete bypass 回歸）'
);

insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a1', 'a@test.dev'),
  ('00000000-0000-0000-0000-0000000000b2', 'b@test.dev');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';

select lives_ok($$select public.create_room(25.0478, 121.5170)$$, 'A 可建房');
create temp table ctx as select id, code from public.rooms limit 1;

set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*) from public.rooms)::int, 0, 'B 未加入前看不到房間');
select lives_ok(format($$select public.join_room(%L)$$, (select code from ctx)), 'B 可用邀請碼加入');
select is((select count(*) from public.rooms)::int, 1, 'B 加入後看得到房間');

update public.room_members set ready = true
  where user_id = '00000000-0000-0000-0000-0000000000a1';
select is(
  (select count(*) from public.room_members
    where user_id = '00000000-0000-0000-0000-0000000000a1' and ready)::int,
  0, 'B 改不動 A 的成員列');

-- lobby 凍結：房間離開 lobby 後，本人也改不動條件
reset role;
update public.rooms set status = 'candidates' where id = (select id from ctx);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
update public.room_members set ready = true
  where user_id = '00000000-0000-0000-0000-0000000000b2';
select is(
  (select count(*) from public.room_members
    where user_id = '00000000-0000-0000-0000-0000000000b2' and ready)::int,
  0, '離開 lobby 後本人也改不動條件');

-- join_room 對已開始的房間應拒絕
select is(
  (select public.join_room((select code from ctx))), null,
  'join_room 對已開始的房間回 null（D25：raise 會回滾 attempt）');
reset role;
select is(
  (select count(*) from public.join_attempts
    where user_id = '00000000-0000-0000-0000-0000000000b2')::int,
  2, '失敗的 join 嘗試會留痕（成功 1 + 失敗 1）');
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';

-- 房主（A）也不能直接改 rooms 敏感欄位（status 由 Go 服務管理）
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select throws_like(
  format($$update public.rooms set status = 'decided' where id = %L$$, (select id from ctx)),
  '%permission denied%', '欄級 grant 擋掉 status 直改');

-- ============ P2：votes 唯讀 RLS（寫入走 Go，D15/D9）============
reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c3', 'c@test.dev');
insert into public.restaurants (id, place_id, name, lat, lng, source) values
  ('99999999-9999-9999-9999-999999999901', 'pg-1', '測試餐廳一', 25.04, 121.51, 'google');
insert into public.room_candidates (room_id, restaurant_id, status, probability) values
  ((select id from ctx), '99999999-9999-9999-9999-999999999901', 'kept', 1);
-- 模擬 Go service role 寫入的一張票
insert into public.votes (room_id, user_id, restaurant_id, kind) values
  ((select id from ctx), '00000000-0000-0000-0000-0000000000a1',
   '99999999-9999-9999-9999-999999999901', 'up');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is(
  (select count(*) from public.restaurants
    where id in (select restaurant_id from public.room_candidates))::int,
  1, '房間成員看得到本房候選引用的餐廳');
select is((select count(*) from public.votes)::int, 1, '成員看得到全房的票');

select throws_like(format(
  $$insert into public.votes (room_id, user_id, restaurant_id, kind)
    values (%L, '00000000-0000-0000-0000-0000000000b2', '99999999-9999-9999-9999-999999999901', 'up')$$,
  (select id from ctx)),
  '%permission denied%', 'authenticated 無 INSERT grant（寫入走 Go）');
select throws_like(
  $$delete from public.votes$$,
  '%permission denied%', 'authenticated 無 DELETE grant（收回也走 Go）');

-- 非成員（C）看不到任何票（D9：policy 否定面）
reset role;
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}';
select is(
  (select count(*) from public.restaurants
    where id = '99999999-9999-9999-9999-999999999901')::int,
  0, '非成員看不到其他房間候選引用的餐廳');
select is((select count(*) from public.votes)::int, 0, '非成員看不到任何票');

-- ============ P2：欄級 grant、探索檔位、join 限流、同席紀錄 ============
-- D17：information_schema 只顯示「當前啟用角色」的 grant——不 reset role 的話
-- anon 那半斷言永遠回空（有人 grant 回去也照綠）。先回 postgres 再驗。
reset role;
select results_eq(
  $$
    select column_name::text collate "default"
    from information_schema.role_column_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'rooms' and privilege_type = 'UPDATE'
  $$,
  $$ values ('exploration') $$,
  'rooms 的 UPDATE 欄級 grant 僅 exploration');

-- 0015：rooms 的 SELECT 也收成欄級。center_lat/center_lng 不在清單裡是刻意的——
-- 圓心是全員座標的中位數，兩人房時就是中點，任一方 other = 2 * center - own
-- 就反推出另一人的精確 GPS，等於繞過 room_member_locations 的零 grant。
-- 這條把欄位清單釘死：日後有人把 center_* 加回去（或整表 grant select）就會紅。
select results_eq(
  $$
    select column_name::text collate "default"
    from information_schema.role_column_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'rooms' and privilege_type = 'SELECT'
    order by 1
  $$,
  $$ values ('code'), ('created_at'), ('exploration'), ('host_id'), ('id'), ('status') $$,
  'rooms 的 SELECT 欄級 grant 精確等於預期欄位集合（center_* 加回去即紅）');

-- 0015：內部函式不可外呼。recompute_room_center 是 security definer，開給 authenticated
-- 等於讓任何登入者對任意 room_id 觸發重算；wrap180 只是它的內部小工具。0015 的 revoke
-- 已明列 authenticated，但那個安全屬性不能只靠 migration 寫對——Supabase 的 default
-- privileges 若哪天改成也 grant execute 給 authenticated，這條就是唯一會紅的地方。
-- 用 has_function_privilege 而不是 role_routine_grants：前者連 PUBLIC 繼承來的權限都算進去，
-- 後者只看得到 grantee = 'authenticated' 那幾筆，grant to public 會整個漏掉。
-- join_room 是正面對照，不是湊數：少了它，整條查詢壞掉（schema 打錯、權限字串打錯）回空集合
-- 時這條照樣綠。權限直接放進結果集而不是拿去 where 過濾，也是同一個理由的延伸——過濾式寫法
-- 下，任一支函式改名或被刪，該列只是從結果裡消失，斷言仍綠；連著 proname 一起比，三支裡
-- 少一支就對不上。
select results_eq(
  $$
    select p.proname::text collate "default",
           has_function_privilege('authenticated', p.oid, 'EXECUTE')
    from pg_proc p join pg_namespace n on n.oid = p.pronamespace
    where n.nspname = 'public'
      and p.proname in ('wrap180', 'recompute_room_center', 'join_room')
    order by 1
  $$,
  $$ values ('join_room', true), ('recompute_room_center', false), ('wrap180', false) $$,
  'authenticated 只叫得動 join_room，叫不動 wrap180 與 recompute_room_center');

select is(
  (select count(*) from information_schema.role_table_grants
    where grantee in ('anon','authenticated') and table_schema = 'public'
      and privilege_type = 'TRUNCATE')::int,
  0, 'anon/authenticated 無 TRUNCATE');

-- 探索檔位：lobby 可調、非 lobby 鎖
reset role;
update public.rooms set status = 'lobby' where id = (select id from ctx);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select lives_ok(
  format($$update public.rooms set exploration = 'explore' where id = %L$$, (select id from ctx)),
  '房主可在 lobby 調探索檔位');
select is(
  (select exploration from public.rooms where id = (select id from ctx)),
  'explore', '檔位已更新');
reset role;
update public.rooms set status = 'candidates' where id = (select id from ctx);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a1","role":"authenticated"}';
select throws_ok(
  format($$update public.rooms set exploration = 'familiar' where id = %L$$, (select id from ctx)),
  '探索檔位僅能在等待階段調整');

-- join_room 限流：一分鐘內第 11 次嘗試被拒（先灌 10 筆再打）
reset role;
insert into public.join_attempts (user_id)
  select '00000000-0000-0000-0000-0000000000b2' from generate_series(1, 10);
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select throws_ok($$select public.join_room('XXXXXX')$$, '嘗試過於頻繁，請稍後再試');

-- 同席紀錄只看得到自己的
reset role;
insert into public.dining_history (user_id, restaurant_id, room_id) values
  ('00000000-0000-0000-0000-0000000000a1', '99999999-9999-9999-9999-999999999901', (select id from ctx)),
  ('00000000-0000-0000-0000-0000000000b2', '99999999-9999-9999-9999-999999999901', (select id from ctx));
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
select is((select count(*) from public.dining_history)::int, 1, '只看得到自己的同席紀錄');

-- ============ 0004：profiles 可見性收緊 + 邀請碼 12 碼 ============
-- B 與 A 同房、C 無共同房。B 的可見集合精確等於 {自己, A}——同房互查保住
-- （RoomPage 的 room_members embed 路徑），無共同房的 C 不可見。
select results_eq(
  $$select id from public.profiles order by id$$,
  $$values ('00000000-0000-0000-0000-0000000000a1'::uuid),
           ('00000000-0000-0000-0000-0000000000b2'::uuid)$$,
  'B 看得到自己與同房的 A，看不到無共同房的 C');
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000c3","role":"authenticated"}';
select is((select count(*) from public.profiles)::int, 1, '無共同房間者只看得到自己的 profile');
select is(length((select code from ctx)), 12, '新房邀請碼為 12 碼');

-- P3 餐後評分：自己的紀錄可評分，別人的碰不到（欄級 grant 只開 rating）
reset role;
select results_eq(
  $$
    select column_name::text collate "default"
    from information_schema.role_column_grants
    where grantee = 'authenticated' and table_schema = 'public'
      and table_name = 'dining_history' and privilege_type = 'UPDATE'
  $$,
  $$ values ('rating') $$,
  'dining_history 的 UPDATE 欄級 grant 僅 rating');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b2","role":"authenticated"}';
update public.dining_history set rating = 4
  where user_id = '00000000-0000-0000-0000-0000000000b2';
select is(
  (select rating from public.dining_history
    where user_id = '00000000-0000-0000-0000-0000000000b2'),
  4, 'B 可評自己的同席紀錄');
update public.dining_history set rating = 1
  where user_id = '00000000-0000-0000-0000-0000000000a1';
-- 空斷言陷阱（OV#14）：B 的 RLS 本來就看不到 A 的列，在 B 的 context 下數恆為 0、
-- RLS 壞了也綠。必須 reset role 用特權視角數（比照 rls_test.sql:70 的既有寫法）。
reset role;
select is(
  (select count(*) from public.dining_history
    where user_id = '00000000-0000-0000-0000-0000000000a1' and rating is not null)::int,
  0, 'B 改不動 A 的評分');
-- 0003 的 rating CHECK 至今無測試，順手釘住（eng review Test Review）
select throws_ok(
  $$update public.dining_history set rating = 6
     where user_id = '00000000-0000-0000-0000-0000000000b2'$$,
  '23514', null, 'rating 超界被 CHECK 擋下');

-- D5：非字串元素在 DB 邊界就擋，堵掉「LoadMembers unmarshal 失敗 → 全房 500」
reset role;
select throws_ok(
  $$update public.room_members set cuisines = '["japanese", 5]'::jsonb
     where user_id = '00000000-0000-0000-0000-0000000000b2'$$,
  '23514', null,
  'cuisines 非字串元素被 CHECK 擋下');

-- ADR-0002：紀錄跟人 —— 刪房不得抹掉同席紀錄
reset role;
delete from public.rooms where id = (select id from ctx);
select is(
  (select count(*) from public.dining_history
    where user_id = '00000000-0000-0000-0000-0000000000a1' and room_id is null)::int,
  1, '刪房後同席紀錄仍在，room_id 轉為 null');

-- 0015：搜尋圓心 = 全員位置的中位數（房主的位置只是 n=1 的特例）
reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000d4', 'd@test.dev'),
  ('00000000-0000-0000-0000-0000000000e5', 'e@test.dev');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000d4","role":"authenticated"}';
select lives_ok($$select public.create_room(25.0, 121.5)$$, 'D 建房');
create temp table ctx2 as
  select id, code from public.rooms where host_id = '00000000-0000-0000-0000-0000000000d4';

set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}';
select isnt(
  (select public.join_room((select code from ctx2), 25.5, 121.75)), null,
  'E 帶著自己的座標加入');
select throws_ok(
  $$select count(*) from public.room_member_locations$$,
  '42501', null,
  'room_member_locations 對 authenticated 無任何 grant：座標不外流給同房成員');
-- 把座標關進零 grant 的表還不夠：圓心本身就是反推管道。兩人房的圓心即中點，
-- 任一方 other = 2 * center - own 就得到另一人的精確座標。
select throws_ok(
  $$select center_lat from public.rooms$$,
  '42501', null,
  '同房成員也讀不到 rooms.center_lat：欄級 grant 切斷「從圓心反推他人座標」');

-- 座標刻意選 2 的冪次組合，中位數在 double 下可精確表示，不用容差比較
reset role;
select is(
  (select center_lat from public.rooms where id = (select id from ctx2)),
  25.25::double precision, '圓心緯度取全員中位數，不再釘在房主身上');
select is(
  (select center_lng from public.rooms where id = (select id from ctx2)),
  121.625::double precision, '圓心經度取全員中位數');

-- 非法座標視同沒給座標，不 raise（同 D25 的理由）：raise 會把同一交易裡剛寫的
-- join_attempts 一起 rollback，攻擊者拿非法座標就能無限打房號而限流永遠加不上去，
-- 順帶做出「合法房號 raise / 非法房號回 null」的房號存在性 oracle。
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000f6', 'f@test.dev');
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000f6","role":"authenticated"}';
select lives_ok(
  format($$select public.join_room(%L, 999, 121.9)$$, (select code from ctx2)),
  'F 帶非法座標加入不 raise');
reset role;
select is(
  (select count(*) from public.room_members
    where room_id = (select id from ctx2)
      and user_id = '00000000-0000-0000-0000-0000000000f6')::int,
  1, 'F 照樣加得進房：非法座標不擋人');
select is(
  (select center_lat from public.rooms where id = (select id from ctx2)),
  25.25::double precision, '非法座標不進中位數，圓心不受影響');
select is(
  (select count(*) from public.join_attempts
    where user_id = '00000000-0000-0000-0000-0000000000f6')::int,
  1, '非法座標的嘗試仍留痕：不 raise 才不會連限流紀錄一起 rollback');

-- 已有座標的成員再次加入卻沒帶座標（回首頁重輸房號、這次拒絕定位）：
-- 舊座標要跟著清掉，否則過期位置繼續把圓心拉過去
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000e5","role":"authenticated"}';
select isnt(
  (select public.join_room((select code from ctx2))), null,
  'E 再次加入，這次沒帶座標');
reset role;
select is(
  (select count(*) from public.room_member_locations
    where room_id = (select id from ctx2)
      and user_id = '00000000-0000-0000-0000-0000000000e5')::int,
  0, 'E 的舊座標被清掉，不再列入中位數');
select is(
  (select center_lat from public.rooms where id = (select id from ctx2)),
  25.0::double precision, '圓心退回只剩 D 的位置（緯度）');
select is(
  (select center_lng from public.rooms where id = (select id from ctx2)),
  121.5::double precision, '圓心退回只剩 D 的位置（經度）');

-- 0015：跨反子午線的房間。逐維中位數直接算會給出 0（圓心從換日線跳到格林威治），
-- 但 179.999 與 -179.999 這兩人實際只相距約 222 公尺，穩穩在搜尋半徑內——
-- 這是正常房間不是病態輸入，所以圓心必須落在換日線上。
reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000a7', 'g@test.dev'),
  ('00000000-0000-0000-0000-0000000000b8', 'h@test.dev');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000a7","role":"authenticated"}';
select lives_ok($$select public.create_room(60.0, 179.999)$$, 'G 在換日線西側建房');
create temp table ctx3 as
  select id, code from public.rooms where host_id = '00000000-0000-0000-0000-0000000000a7';

set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000b8","role":"authenticated"}';
select isnt(
  (select public.join_room((select code from ctx3), 60.5, -179.999)), null,
  'H 在換日線東側加入');

reset role;
select is(
  (select center_lat from public.rooms where id = (select id from ctx3)),
  60.25::double precision, '緯度沒有環繞問題，中位數照算');
-- 179.999 不是 2 的冪次，平移與折回會累積浮點誤差，經度用容差比而不是 is()
select ok(
  abs((select center_lng from public.rooms where id = (select id from ctx3)) - (-180)) < 1e-9,
  '圓心經度折回換日線（-180），不是逐維中位數的 0');

-- 0015：精確座標的 24 小時 TTL。freeze.go 只在凍結成立時整房刪座標，一直留在 lobby 的
-- 房間（被放生、或每次搜尋都撞 422/502/零候選）走不到那條路徑，靠 create_room 順手掃。
-- 計齡以整房的 max(updated_at) 為單位、整房一起刪：老房間裡也會有剛送出的新座標，
-- 而逐列刪會留下「圓心含著已刪座標」的混合態（掃描不重算圓心，重算會把圓心跳到唯一的
-- 新鮮座標上，等於把位置舊一點的成員踢出計算）。
reset role;
insert into auth.users (id, email) values
  ('00000000-0000-0000-0000-0000000000c9', 'i@test.dev'),
  ('00000000-0000-0000-0000-0000000000d0', 'j@test.dev'),
  ('00000000-0000-0000-0000-0000000000e1', 'k@test.dev');

set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000c9","role":"authenticated"}';
select lives_ok($$select public.create_room(24.0, 120.0)$$, 'I 建房，稍後假裝它被放生');
-- 房號要在房主身分下抓：rooms 的 RLS 讓非成員讀不到這一列，K 自己 select 會拿到 null
create temp table ctx4 as
  select id, code from public.rooms where host_id = '00000000-0000-0000-0000-0000000000c9';

set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}';
select isnt(
  (select public.join_room((select code from ctx4), 24.1, 120.1)), null,
  'K 加入 I 的房間');

-- 房間與整間房的座標（含 K 的）一起放到 25 小時前。房間本身也要放老，這才是 reviewer 指出的
-- 真實情境「老 lobby 房間 + 剛送出的新座標」；只放老座標的話，改回用 rooms.created_at 計齡
-- 會因為房間還新而一列都不刪，下面那條關鍵斷言就擋不住這個退化。
-- rooms 的 UPDATE 欄級 grant 只開 exploration，room_member_locations 沒開任何 authenticated
-- grant，兩張表都要 postgres 身分才改得動
reset role;
update public.rooms set created_at = now() - interval '25 hours'
  where id = (select id from ctx4);
update public.room_member_locations set updated_at = now() - interval '25 hours'
  where room_id = (select id from ctx4);

-- K 在這間老房間裡重新加入、送出新座標：on conflict 分支要把 updated_at 推回 now()。
-- 少了那行，K 的座標時間永遠停在第一次加入，下面「新鮮座標存活」那條就會紅。
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000e1","role":"authenticated"}';
select isnt(
  (select public.join_room((select code from ctx4), 24.2, 120.2)), null,
  'K 重新加入老房間，送出新座標');

set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000d0","role":"authenticated"}';
select lives_ok($$select public.create_room(24.5, 120.5)$$, 'J 建新房，觸發 TTL 掃描');

reset role;
-- 這條的預期在第六輪翻面（原本斷言 I 那筆 25 小時前的座標被「單獨」掃掉）：
-- 逐列刪會讓這間還開著的房間留下混合態——I 的座標沒了，rooms.center_* 卻仍是含著它算出
-- 來的中位數，掃描不重算，房主下次搜尋拿到的還是那個舊聚合值。改成逐房 all-or-nothing 之
-- 後，K 剛送出的新座標把整房年齡拉回新鮮，I 這筆舊座標就跟著整房一起留下。
select is(
  (select count(*) from public.room_member_locations
    where room_id = (select id from ctx4)
      and user_id = '00000000-0000-0000-0000-0000000000c9')::int,
  1, '老房間有新鮮座標：整房不清，那筆 25 小時前的舊座標也留著');
-- 房間本身超過 TTL，但 K 的座標是剛送出的，必須存活。改用 rooms.created_at 計齡會連它一起
-- 刪；join_room 的 on conflict 漏掉 updated_at = now() 也會讓整房年齡停在過去而一起被刪。
select is(
  (select count(*) from public.room_member_locations
    where room_id = (select id from ctx4)
      and user_id = '00000000-0000-0000-0000-0000000000e1')::int,
  1, '老房間裡剛更新過的座標存活');
select is(
  (select count(*) from public.room_member_locations
    where room_id = (select id from public.rooms
                      where host_id = '00000000-0000-0000-0000-0000000000d0'))::int,
  1, '新房自己的座標還在');
-- 上一條擋不到「where 寫壞成整表刪」——新房的座標是掃描跑完之後才插進去的。
-- 掃描當下就已存在的新鮮房間（G/H 那間）才是誤刪的照妖鏡。
select is(
  (select count(*) from public.room_member_locations
    where room_id = (select id from ctx3))::int,
  2, '掃描當下就存在的新鮮房間，座標一列都沒少');

-- 本輪的核心不變式，用同一間房、同樣兩列走完兩種狀態：上面那次掃描整房都留（K 是新鮮的），
-- 現在把整房座標（含 K 那筆）一起放到 25 小時前再掃一次，兩列必須一起消失。只有「全在」與
-- 「全沒了」兩種狀態，就不會出現「rooms.center_* 含著已刪座標」的不一致——全沒了的時候，
-- center_* 剛好就是那批被刪座標算出來的聚合值，所以掃描不需要重算圓心。
reset role;
update public.room_member_locations set updated_at = now() - interval '25 hours'
  where room_id = (select id from ctx4);

-- 掃描跑在 create_room 寫入自己那列之前，所以 I 新開的這間不會掃到自己
set local role authenticated;
set local "request.jwt.claims" = '{"sub":"00000000-0000-0000-0000-0000000000c9","role":"authenticated"}';
select lives_ok($$select public.create_room(24.9, 120.9)$$, 'I 另開一房，觸發第二次 TTL 掃描');

reset role;
select is(
  (select count(*) from public.room_member_locations
    where room_id = (select id from ctx4))::int,
  0, '整房座標都過期：兩列一起清空，不留混合態');

select * from finish();
rollback;

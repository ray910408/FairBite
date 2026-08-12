-- rooms 的 SELECT 收成欄級：center_lat/center_lng 不再開給 authenticated。
-- 搜尋圓心就是房主開房當下的精確位置。members_select 讓同房成員讀得到整列 rooms，
-- 整表 grant select 等於把房主的家門口攤給任何拿到邀請碼的人——邀請碼進得來的人
-- 不必是房主信得過的人（碼會被轉貼、截圖、群組外流）。
-- center_* 之後只有 security definer function 與 service role（Go 服務端）讀得到；
-- 前端本來就不需要圓心，Go 引擎才需要。
-- UPDATE 早在 0003 已是欄級（僅 exploration），不動。
-- 前端連帶要改：PostgREST 的 select('*') 會展開成全欄位，撞到欄級 grant 會 permission denied，
-- 所以 useRoom.ts 改成明列欄位（見該檔註解）。
revoke select on public.rooms from authenticated;
grant select (id, code, host_id, status, exploration, created_at)
  on public.rooms to authenticated;

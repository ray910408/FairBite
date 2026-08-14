-- 2026-08-14 production QA（ISSUE-001）善後：0015–0019 未推上線期間，前端
-- create_room 成功但進房查詢炸 42703（rooms.meal_time 不存在），留下無人進得去的
-- lobby 孤兒房（5 間使用者自試＋2 間 QA 重現，另含一間 8/12 廢棄舊房，共 8 間）。
-- 一次性出清，冪等；時間上界固定在 schema 修復完成時刻，重放（db reset / CI /
-- 未來環境）不會誤刪修復後建立的正常房。
delete from public.rooms
where status = 'lobby' and created_at < '2026-08-14T08:05:36Z';

---
status: accepted
---

# Realtime 不推播 DELETE，刪除改由 rooms 的 UPDATE 通知

2026-10-04 本機實證（Realtime v2.120.3）：Supabase Realtime 對 `postgres_changes` 的 DELETE 不套 RLS，官方文件也明寫。`realtime.apply_rls` 遇到 DELETE 直接放行所有訂閱者，只把 old 裁到 PK。結果是任何已登入的非成員（含訪客）都能訂閱別房、甚至指定別房的 `room_id`，收到投票（含誰否決哪家店）、初選圈選、退房、候選清單的刪除事件。進入待定或換地點時整房票一次清空，等於把全房選票送給偷聽者。決定：`supabase_realtime` publication 停發 DELETE；每張發布中、帶 `room_id` 的表加 statement 層級的 AFTER DELETE trigger，把 `rooms.delete_version` 加一，讓成員經由有 RLS 把關的 `rooms` UPDATE 得知要重抓。

## Considered options

- 停發 DELETE + rooms 版本訊號 — 已選擇；一個 migration 堵住現有與未來所有表，前端本來就只把事件當 refetch 訊號，不必改。
- Broadcast from Database 私人頻道 + `realtime.messages` RLS — 未採用；官方推薦、可帶內容，但前端訂閱與 8 張表的推送都要重寫，目前沒有需要事件內容的功能。
- 軟刪除（UPDATE 標記）— 未採用；所有讀取與 PK 重投語意都要改。
- 調整 `REPLICA IDENTITY` — 無效；FULL 時 old 仍裁到 PK，NOTHING 則讓發布中的表無法 DELETE。

## Consequences

- 新增的房內資料表要嘛不放進 publication，要嘛掛上 `signal_room_delete`；`supabase/tests/realtime_delete_privacy_test.sql` 對帳兩者，並鎖住 `pubdelete = false`。
- 只有 trigger 內發出的刪除（rooms 的 BEFORE UPDATE 清子表）不另發訊號：外層 rooms UPDATE 本身就會推播。FK cascade 在外層語句收尾時觸發，照常遞增；退房一次可能推好幾個 rooms UPDATE，前端 debounce 會合併；刪房時是對已刪列的空 UPDATE。
- 每次刪除會改到同一列 rooms；後端各流程本來就先 `for update` 鎖住 rooms，不新增鎖序。
- 同一使用者開多個分頁時，一個分頁退房，另一個分頁不會即時收到。以前會收到，是靠這個漏洞：自己那筆 room_members DELETE 會推給已不是成員的人。rooms UPDATE 經 RLS 判定時他已非成員，要等重連或下一個操作被拒才發現。
- 線上靠 publication 設定把關，Dashboard（Database → Publications）手動打開 Delete 會讓漏洞無聲復活；pgTAP 只跑在 local stack，部署檢查見 `docs/deploy.md`。

# 房間採一次性生命週期

每次餐廳決策都建立新房；房間進入 `decided` 即為終態，不提供重開。現行狀態機已符合這個生命週期，不需新增重開路徑。需求方於 2026-08-10 的 P3 plan review D9 裁定此產品邊界。

因此不為超過 30 天的舊房重刷 Google Places 快取，也不在舊房加過期標註。長期只保留系統自產歷史：透過 `restaurants` 保留的 `place_id` 參照、`dining_history.decided_at`、`exposure_stats`，以及滿足度資料 `rating` / `pref_hit`。

## Considered options

- 重開舊房時以 `place_id` 重刷餐廳資料 — 增加狀態恢復、快取與部分失敗語意，但一次性決策不需要，拒絕
- 舊房保留快取快照並標示過期 — 仍要維護不可操作的歷史房 UI，且與 Google Places 30 天快取條款拉扯，拒絕

## Consequences

- UI 與 API 不提供 `decided` 回到前一階段的操作；再次決策一律建新房
- 房間資料可依未來保留政策清理，但不得抹掉個人同席紀錄；`dining_history.room_id` 刪房時改為 `null`（migration 0011，呼應 ADR-0002）
- 舊房不承擔長期展示第三方快取的責任；跨房間公平與回顧只依系統自產歷史計算

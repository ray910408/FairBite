# 房間採一次性生命週期

每次餐廳決策都建立新房；只有房主確認待確認結果後進入的 `decided` 才是終態，不提供重開。房主可在 `candidates`、尚未開始投票時用 `POST /api/rooms/{id}/edit-conditions` 回到 `lobby` 修訂同一次決策；改地點表決通過後也可由房主選新出發點回到 `lobby`。這些路徑會清除舊候選與票、把全員 `ready` 歸零，但保留房間、成員、邀請碼與個人條件；都不是重開已定案房間。需求方於 2026-08-10 的 P3 plan review D9 裁定一次性邊界，並於 2026-08-20、2026-09-17 補上定案前候選修訂與待確認流程。

因此不為超過 30 天的舊房重刷 Google Places 快取，也不在舊房加過期標註。長期只保留系統自產歷史：透過 `restaurants` 保留的 `place_id` 參照、`dining_history.decided_at`、`exposure_stats`，以及滿足度資料 `rating` / `pref_hit`。

## Considered options

- 重開舊房時以 `place_id` 重刷餐廳資料 — 增加狀態恢復、快取與部分失敗語意，但一次性決策不需要，拒絕
- 舊房保留快取快照並標示過期 — 仍要維護不可操作的歷史房 UI，且與 Google Places 30 天快取條款拉扯，拒絕

## Consequences

- UI 與 API 不提供 `decided` 回到前一階段的操作；再次決策一律建新房
- `candidates → lobby` 僅供房主修訂本次條件；重新搜尋會建立新的候選與曝光紀錄，不回滾前一次已累計的推薦曝光
- `pending` 仍屬未定案：房主可確認進入 `decided`，或排除結果重轉；候選耗盡時回 `lobby`
- 房間資料可依未來保留政策清理，但不得抹掉個人同席紀錄；`dining_history.room_id` 刪房時改為 `null`（migration 0011，呼應 ADR-0002）
- 舊房不承擔長期展示第三方快取的責任；跨房間公平與回顧只依系統自產歷史計算

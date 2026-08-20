# 投票寫入集中為單一 Go 領域命令

2026-08-05 設計（spec §7）讓客戶端直寫 `votes`，靠 RLS + DB trigger 把關，重算另走一個 `rescore` endpoint。但一次投票不是一次簡單寫入：它同時牽涉三個跨列不變式——階段（只有 `voting` 能投）、冪等（連點/重送不得變成兩次語意）、限額（每人每房現存否決 ≤ 2）——沒有一條 INSERT 表達得出來，而且寫票與重算是兩個往返，中間可以插進別人的票或房主的抽選。決定：投票/否決/收回改走單一領域命令 `POST /api/rooms/{id}/vote`（body `{restaurant_id, kind: up|veto, op: cast|retract}`），Go 在**一個交易**內依序完成條件式 room row lock（驗階段、序列化同房投票、擋併發抽選）→ 冪等 → 限額（`VetoQuota = 2`，`server/weights.go`）→ 寫票 → inline rescore，回應即權威結果。`votes` 的四欄 PK 本來就允許同一會員對同一家店同時保有 `up` 與 `veto`：veto 是可收回的排除 overlay，不會取代 up；本次只改命令語意，無 DB migration。表保留宣告式 invariant（四欄 PK、`kind` CHECK、FK、成員可讀 RLS、Realtime），移除業務 trigger、advisory lock 與 authenticated 的寫入 policy/grant；獨立的 rescore endpoint 取消。本決策 supersedes spec §7 的 2026-08-05 直寫分工。

## Considered options

- 客戶端直寫 + trigger 把限額（2026-08-05 原設計）— 三個邊界各要補一個機制：限額要 advisory lock 才擋得住併發、冪等要前端解讀 23505、機率一致性要靠額外的 rescore 呼叫，成本高於直接集中，拒絕
- 保留直寫、只把重算收進 Go — 寫票與重算之間永遠有一段票數與機率不一致的視窗，抽選可能落在該視窗內，拒絕
- 反向全下放 DB（trigger 管階段/互斥/限額）— 業務規則散在 Go 與 PL/pgSQL 兩種語言，`VetoQuota` 這類可調參數得在 weights.go 與 migration 各維護一份，拒絕

## Consequences

- 可調參數只剩一份權威（`server/weights.go`）；DB 不再持有業務數字，改規則不必動 migration
- 前端不需處理 duplicate key 與樂觀更新回滾；Realtime 仍以 DB 變更為同步來源；命令回應 payload 仍是 API contract 的一部分，但目前 web client 不消費，成功後依 Realtime + debounce refetch 取得結果
- 每次投票多一次 Go 往返，且同房投票被 room row lock 序列化——單一房間規模下可接受，若日後房間人數量級改變需重新評估鎖粒度
- `votes` 的寫入路徑只有 service role 一條，安全面收斂；相對地 Go 必須自己測到三個不變式，測試責任從 pgTAP 移到 handler tests

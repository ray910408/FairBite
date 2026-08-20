# Task 4 implementer report

## Result
- 同店 `up` 與 `veto` 現在是獨立 vote rows；收回 veto 不會刪除 up。
- Web 按 kind 判定自己的票；veto 額度用盡時仍可收回既有 veto，up 不受影響。
- ADR-0003 與產品 spec 明載 veto 為可回收 overlay，既有四欄 PK 已支援，無 DB migration。

## RED
1. `go test -run '^TestVotingFlow$' -count=1 -v`：同店 cast veto 後得到 `up=0 veto=1`，證實 server 刪除了另一 kind。
2. `npm.cmd test -- src/lib/votes.test.ts src/pages/RoomPage.test.ts`：mirror 移除 up、`hasMyVote` 不存在、veto retract control 無法 render。

## GREEN
- `TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres go test -run '^TestVotingFlow$' -count=1 -v` — PASS.
- 同一 DB URL 的 `go test ./...` — PASS.
- `npm.cmd test -- src/lib/votes.test.ts src/pages/RoomPage.test.ts` — 37 passed.
- `npm.cmd run e2e -- full-loop.spec.ts` — PASS（`web/test-results/.last-run.json` 為 `status: passed`）。
- `npm.cmd run build` — PASS.

## Attempts / notes
- Go 首次受 sandbox 系統 build cache 權限阻擋；取得執行權限後 RED/GREEN 都以指定 DB URL 執行。
- E2E 初次因未啟動 API/Vite 連線被拒；啟動後 Google 即時資料使既有測試不穩定，改用本機 mock Places provider 後整個 full-loop 通過。
- `TestVotingFlow` 初版 retract assertion 未排除第二家既有 veto，已修正為預期 `up=1, veto=1`。

## Self-review
- server 僅移除 cast 時刪除另一 kind 的 SQL；validation、quota、idempotency、transaction、rescore、剩餘 veto 額度保留。
- mirror 只 filter 同一 kind；無 `myVoteKind` 留存；變更測試無 `skip` / `only` / `TODO`。
- Commit state: staged and committed on `codex/fairbite-qa-root-fixes` (Task 4 only; no push).

# TODOS

只列未結案項目；已結案的原文移到 `docs/todos-archive.md`（2026-10-11 封存）。

## P2 eng review 新增（2026-08-06）

- Google currentOpeningHours（假日/特別時段）與 30 天快取條款結構性衝突 — date-specific 時段需要獨立的短效快取語意，留待 P3 設計（regularOpeningHours 的假日誤差為本期接受的限制）。
  P3 明確排除：需要獨立的短效快取設計輪。

- **晚餐/其他時段 × 菜系加成：** 待 provider tag 詞彙擴充、`googleTypeTags` 有真實對映後回歸；新增 slot 的前置條件已註記於 `server/weights.go`（P3 eng review D23）。（2026-08-13：hotpot 已有真實映射，前置滿足；開 slot 與否仍是獨立產品決策。）

### Round 3 審查遞延（2026-08-15）

- **無名店 chain key 碰撞**：`chainKey("")` 會把多家 `displayName` 缺漏的無名店塌成一家；Google 幾乎必回 `displayName`，機率低。修法：key 為空時跳過 dedupe。

### 菜系打標修復的延後項（2026-08-16 eng review 拆出）

完整內容（含程式碼與 ADR 修訂文字）在 `docs/superpowers/plans/2026-08-16-cuisine-tag-accuracy.md` 的 Task 5／6。以下各項**不在** Task 1–4 的 PR 內。

- **Task 7 Stage B2 仍 blocked**（Stage B1 已結案，見封存的 `beef_noodle` 條）：先部署並驗證 Pages 只寫 supported dietary、Render 接受 legacy rows，才可做 cleanup/constraint migration。

- **`western` 跨區 query match 誤放行尚未量化**
  - **What:** 「西式料理」的定向檢索會把泰式餐酒館、陝西餐館標成 western（`QueryMatches` 與 canonical tag 等權，`engine.go:234`）。
  - **Why:** 2026-08-16 實測 types 支持率 27%，但那個數字混了兩種原因：`western_restaurant`／`european_restaurant` 未對映（Task 1 已修）與真正的跨區誤放行。修法（`gRejectQueryMatch` 的 tier3）是否值得做，取決於後者的實際比例。
  - **Depends on:** Task 1 落地後重跑量化。門檻定為 10%，未達就不做並記錄結果。

- **`light_meal` 25% 支持率：判定不修，記錄理由**
  - Google 沒有「輕食」對應的 type，query match 正在做 ADR-0006 設計它做的事；抽樣中的沐莛輕食、參食健康餐盒確實是輕食。唯一勉強算錯的是早餐店拿到 `light_meal`，傷害低。若日後有人重看這個數字，不必再查一次。

- **`cuisine_filter=ON` × 素食成員：純素食店會被 kind "cuisine" 硬排除（已知代價，2026-08-17 final review I1）**
  - **What:** 房主開啟菜系過濾時，Task 2 新召回的純素食店（cuisine_tags 只有 `vegetarian_friendly`）滿足不了任何成員的 `memberLikes`（`engine.go` 只讀 `m.Cuisines`，`QueryMatches["vegetarian"]` 不算命中）→ 被 kind "cuisine" 排除 → 素食成員在過濾開啟的房間比 merge 前更容易看到 422。
  - **Why:** 方向符合 ADR-0001（寧漏勿誤放行）——舊行為是靠 `servesVegetarianFood` 假 tag 讓素食成員看到「錯的候選」。此為刻意取捨，不是缺陷。
  - **Depends on:** 要改就是動 `memberLikes` 命中定義，屬 ADR-0006 範圍——與 Task 5（beef_noodle／ADR 修訂輪）同批評估。

- **上線 checklist：先 Render 後 0023／0024**
  - **What:** merge 後先確認 Render 已部署新 server binary，再讓 `deploy-pages.yml` 的 migrate job 跑 `0023_purge_svf_vegetarian_tags.sql` 與 `0024_remap_cuisine_tags_after_type_census.sql`。順序反了＝舊 binary 用 `servesVegetarianFood`／`chinese_restaurant → taiwanese` 把 tag 寫回快取（無告警、0023 那條方向是誤放行）。
  - **Why:** 這兩支要的是「Render 先、migration 後」。2026-10-11 起 `deploy-pages.yml` 固定 DB → API → Web，方向剛好相反；同型 migration 之後一律拆兩個 PR（先合程式、等 `deploy-api` 綠，再合 migration），見 `docs/deploy.md`。
  - **補救:** 兩支都冪等——順序反了就在 Render 部署完成後各重跑一次（migration 檔頭有註記）。

### Google Places attribution logo 確認（正式上線前）

- **What:** 依當時最新版 Google 品牌指南確認「Powered by Google」logo 資產與使用方式；目前 UI 已依 `place_id` 自動為 Google 來源資料顯示文字歸因。
- **Why:** 品牌資產與規範可能更新，正式上線前需以當時版本做最後確認。
- **Depends on:** hosted 正式上線計畫。

### E2E 降級快取情境（provider 斷線編排）

- **What:** Playwright 補「Places 失敗 → 30 天快取 fallback → 降級橫幅」的自動化情境。
- **Why:** 伺服器端降級鏈已有 Go 測試，但「使用者看到橫幅」這最後一哩只有手動驗證（2026-08-06 eng review D10 認定值得自動化、成本高於當批範圍）。
- **Pros:** 降級鏈全程進回歸網。
- **Cons:** 需讓 Go server 的 provider 中途失效——測試旗標（如 `PLACES_FORCE_FAIL=1`）或雙 server 編排，基建成本高。
- **Context:** 起點：`server/main.go` provider 切換處加測試旗標；E2E 前置腳本以該旗標啟動第二個 port。
- **Depends on:** P2 Task 13 完成；CI 已有 `e2e` job（2026-10-11），情境寫好可直接掛上。

### Places 花費防線：budget alert + cache-first 評估（hosted 前）

- **What:** GCP 帳務預算警報（純 ops）；並評估 cache-first 搜尋策略（快取夠新鮮夠密時跳過 API 呼叫）。
- **Why:** 每次 search 是一次 Nearby Search Pro SKU 計費呼叫（FieldMask 含 regularOpeningHours/rating）。個人規模趨近零成本，hosted 開放他人用後無任何花費防線（2026-08-06 outside voice #8）。
- **Pros:** 第一層（alert）零程式碼。
- **Cons:** cache-first 涉及「快取是否涵蓋該區域」判定與營業時間新鮮度取捨，屬產品決策——當批已明確拒絕立即重設計。
- **Context:** search 每房僅一次且被狀態機閘住，濫用面已小。
- **Depends on:** hosted 部署；與 limiter TTL 同群。

### vote 回應的 vetoes_remaining 未被 web 消費（arch review，2026-08-11）

- **What:** 審查建議讓 web 消費 vote 回應的 `vetoes_remaining`，取代目前由票列本地推導剩餘否決額度。
- **Why:** 多分頁或 Realtime 中斷時，本地推導的剩餘額度會落後真實值。現況依 ADR-0003（`docs/adr/0003-centralized-vote-write-command.md`）：payload 仍是 API contract 的一部分，但 web 不消費，成功後靠 Realtime + debounce refetch 對齊。若日後出現實際回報再改。

## 工具鏈（2026-10-11）

- **升級 Supabase CLI 前先處理 `20260905000300_private_scoring_snapshots.sql`** — 第 7 行的 `lock table` 不在交易區塊內。CI 與 Deploy web 釘的 CLI 2.113.0 照常套用，但 2026-10-11 用本機 CLI 2.119 從頭套 migrations 時報 `LOCK TABLE can only be used in transaction blocks`。改 `ci.yml`／`deploy-pages.yml` 的 `version: 2.113.0` 之前要先決定怎麼修（這支已套用到正式站，改既有 migration 前先確認 CLI 不會因此重套）。

## Round 1 final review 遞延（2026-08-13）

- **LocationPicker 錯誤處理 polish 三合一**：Leaflet dynamic import 加 `.catch`（現為灰框靜默）、searchPlaces 逾時/離線錯誤中文化（現原文英文直出）、錯誤訊息補 `role="alert"`。起點 `web/src/components/LocationPicker.tsx`。
- **雙頁時/分 select JSX 抽共用元件**：HomePage/RoomPage 各 18 行複製；第三處出現再動手。

## P2 候選

### Final review 遞延（2026-08-06）

feat/phase-1 全分支 final review 的 DEFER-P2 批次。原本優先的前三項（安全/依賴面）已全數結案，見封存；以下為測試缺口與 UX 細節，沿用原編號。逐條出處見本機 `docs/superpowers/sdd-ledger-phase1.md`（未納入版控）。

- **#4** `NewVerifier` 的 `len(secret) < 32` 拒啟動分支無測試。
- **#6** `handle_new_user` 保留預設 `EXECUTE TO PUBLIC`（returns trigger 不可直呼，僅不一致）。
- **#7** grant 矩陣 pin 只盯 `grantee='authenticated'`，grant to PUBLIC 的放寬不會觸發。
- **#8** `MinutesUntilClose` 的 `-1`（未營業）路徑無測試。
- **#9** 引擎正向保留路徑無測試（具 `vegetarian_friendly` 應保留、雙衝突 tag = 2 reasons 1 kind、Kinds 集合內容）。
- **#10** 抽選無「壞 seed 非空清單」與「打亂順序同 winner」回歸測試。
- **#11** 並發 draw 的 23505 / transition conflict 無實測（僅狀態前置檢查覆蓋）。
- **#12** `[]` / `null` 契約無測試斷言（現有測試 excluded/kept 皆非空）。
- **#13** createRoom 錯誤訊息透傳 raw message，與 join 不對稱。
- **#14** **UI 元件測試基建（@testing-library + jsdom）一次性補全** — slider label、toggle `aria-pressed`、auth/home `aria-label` 已於 2026-08-06 /qa 處理；殘留料理/禁忌群組的程式化關聯，與 RatingPrompt、RecentRatingPrompt、偏好建議橫幅、`applyDefaultPrefs` 的元件層零自動化覆蓋一次補全。偏好建議橫幅 UI 膠水依既有 test-plan artifact 手動 QA，不另上 E2E（P3 eng review D14/D15）。Round 2 足跡頁新增缺口一併納入：HistoryPage 載入／錯誤＋重試／空狀態／>500 footer 四態，與清單列 StarRow 錯誤分支；另 Round 2 E2E 重排後，房內 RatingPrompt 的互動寫入分支（點星後 onRated=setRating 即時切靜態文案的膠水）E2E 覆蓋歸零，批次補全時一併恢復。Round 4 新增：RoomPage 搜尋中（searching）房間設定控制 disabled 的元件斷言一併納入批次。2026-10-11 新增：RoomPage 拆檔後 18 個 state 仍集中在頁面，因為 `RoomPage.test.ts` 依呼叫順序 mock `useState`／`useEffect`（子元件多開一個 state 就擠動索引）；這支測試改成行為導向後，state 才能下放到 `RoomSettings`、`DrawPanel` 等子元件。2026-10-12：RoomPage 與 HistoryPage 的測試已改成行為導向（`RoomPage.test.tsx`／`HistoryPage.test.tsx`：@testing-library/react＋jsdom，檔頭 `// @vitest-environment jsdom`，共用設定在 `web/src/test/dom.ts`，全域 environment 仍是 node），Round 4 的 searching 停用房間設定斷言一併補上；`RoomHeader`／`MemberList`／`RoomSettings` 已改回 JSX，兩頁的離席流程抽成 `hooks/useLeaveDialog.ts`，RoomPage 的 state 現在可以下放。上面列的缺口裡，已有行為測試的：足跡頁空狀態（「回首頁開一場」入口）、清單列補評送出後焦點回到該列、StrictMode 雙掛載時晚到的舊載入不蓋掉新結果，以及房內定案後依 `is_anonymous` 顯示的訪客註冊提示；仍無覆蓋的：HistoryPage 載入中／錯誤＋重試／>500 footer、清單列 StarRow 的錯誤分支、房內 RatingPrompt 的互動寫入分支。2026-10-13：其餘 mock react hook 的測試也改成行為導向，`web/src` 已無 `vi.mock('react')`——HomePage／JoinPage／AuthPage／ConditionsForm／StarRow 改成 `.test.tsx` 真的 render，`hooks/useRoom.test.ts`、`hooks/useMidnightRerender.test.ts` 改用 `renderHook`，`Wheel.recovery.test.tsx`、`GuestRegistrationPrompt.test.tsx` 改真的 render；`LeaveConfirm` 各頁已改回 `<LeaveConfirm />`。首頁評分卡（RecentRatingPrompt → StarRow 寫入 → `onRated` 重新載入建議）與偏好建議橫幅的文字也已由 `HomePage.test.tsx` 實際跑過；mutation 找到、新舊測試都沒守住的分支見下方「行為測試仍未守住的分支」。`useRoomSettingsWrites` 只開 ref、閘門與用餐時間草稿放在 RoomPage 是當初遷就舊測試的寫法，現在可以收進 hook。
- **#15** unmount 未清 debounce timer。
- **#18** `Wheel` 的 `!s` 分支是 dead-end（實務不可達）。

### 搜尋進行中房間被刪仍回 500（server 可維護度重構 review 遞延，2026-10-12）

- **What:** 搜尋進行中房間被刪（例如唯一成員的房主在 Places 呼叫期間從另一個分頁退房），仍回 500「資料庫錯誤」。有餐廳時，`freezeSearchCandidates` 的 `assertHostInTx` 回 `ErrRoomNotFound`，它不是 `ErrNotHost`，於是走 `serverError`，log 記 "room not found"；零筆時，`rejectChangedSearchSnapshot` 從 `checkSearchSnapshot` 拿到 `pgx.ErrNoRows`，log 記 "no rows in result set"。
- **Why:** 改之前也是 500，不算回歸；要測就得編排搜尋競態，成本高，所以延後。其他房間動作在房間被刪後已回 404「房間不存在」。
- **修法:** 在 `server/search.go` 的 `assertHostInTx` 錯誤分支先判斷 `ErrRoomNotFound`，回 404「房間不存在」；`checkSearchSnapshot`（`relocation.go`）讀房間列的 `ErrNoRows` 也用 `roomRowErr` 轉成同一個 sentinel。光轉 sentinel 仍是 500，因為 `rejectChangedSearchSnapshot` 只分 `ErrSearchChanged` 與其他：`rejectChangedSearchSnapshot` 也要加 `ErrRoomNotFound` → 404 的分支。它的兩個呼叫端要一併檢查：零筆的 `respondNoRestaurants`，以及 provider 失敗且沒有快取的那條路徑（`fetchSearchRestaurants`，回 502 之前）。

### 行為測試仍未守住的分支（測試轉換 review，2026-10-13）

review 用 mutation 找到、新舊測試都不會發現的改壞方式。不是這次轉換造成的退步，逐條補即可。

- **useRoom:** 拿掉 `live` 旗標（舊 channel 晚到的 CLOSED 蓋掉新連線）；CLOSED／CHANNEL_ERROR 時不把 `connected` 設成 false；旁表查詢錯誤沒算進 `loadError`；旁表出錯時照樣覆寫既有 state。`useRoom.test.ts` 已有 channel status 的替身，補起來便宜。
- **ConditionsForm:** 拖曳中 debounce 不重新起算。
- **StarRow:** 預覽與已選誰優先對調；重試前沒先清掉舊錯誤。
- **GuestRegistrationPrompt:** 註冊連結沒帶 `?mode=register`。
- **AuthPage:** 匿名使用者在註冊模式也顯示顯示名稱欄；匿名使用者也套用升級標記；`applyUser` 的 else 分支沒把 resume 重設。預熱 `fetch` 的 `.catch` 在目前寫法下測不到：`vi.fn` 回傳的 promise 本身就算有人接。
- **JoinPage:** 換邀請碼後，舊那一輪晚到的錯誤顯示在新邀請上（數道守衛各自都沒守住）；只填空白的暱稱照樣送出；忙碌中也顯示重試；換邀請時沒收掉暱稱表單。
- **HomePage:** 用邀請碼加入成功後的導頁；切換用餐時間模式時沒清掉建房錯誤。

### 封鎖網站資料與加入頁的舊問題（修讀碼問題時 review 發現，2026-10-13，未修）

- **封鎖網站資料的瀏覽器，正式會員建不了房:** `HomePage.tsx` 的 `loadAuthState` 讀 `guest-upgrade:<uid>` 丟錯，被 catch 接成 `authState='error'`，建房鈕換成一顆永遠失敗的「重新檢查」。supabase-js 在 storage 被封鎖時會退回記憶體儲存，登入本身可用，所以影響比原本以為的大。`HomePage.test.tsx` 的「localStorage error 時 fail closed 並可重試」把這當成預期行為：讀不到升級標記就分不出訪客或會員。要改得先決定 fail closed 是否仍是想要的。
- **AuthPage 讀升級標記丟錯時狀態沒更新:** `applyUser` 在 `setUser` 之後讀 `guest-upgrade:<uid>`，丟錯被 `refreshUser` 的 `.catch` 吞掉，後面的升級狀態與模式都沒套用。
- **GuestRegistrationPrompt 記回房路徑沒包 try:** 「註冊並保留紀錄」的 onClick 直接 `sessionStorage.setItem`，丟錯時回房路徑記不下來，click handler 也中斷。
- **加入頁的多房確認框:** `LeaveRoomsBody` 多房文案寫「回首頁會一次全部離開」，但加入頁按的是「離開並加入」；按下「離開並加入」送出中（busy）時，各房的回房鈕仍可點。

## /qa-only 線上站 QA + PR #17 review 殘留（2026-08-16）

QA 對象 https://ray910408.github.io/FairBite/#/auth（headless，test 帳號）。ISSUE 編號對應 `.gstack/qa-reports/qa-report-fairbite-2026-08-16.md`（該目錄被 .gitignore 蓋住，只在本機）。PR #17 已修 ISSUE-001（回首頁離席確認）與 ISSUE-003（星排視覺）；ISSUE-005／006／008 已修，見封存。

- **ISSUE-002（High，未修，待確認是否結案）預設條件產生退化結果集**（2026-10-10 複測已不重現：預算改 Google 價位層級後，台北 101 全預設以真 API 搜尋保留 14 家、排除 4 家。下方為原始紀錄） — 全預設（NT$300 上限／800m／步行）在台北 101 搜尋，15 家排除 14 家、全部理由都是「超過 NT$300」，只剩 1 家候選、抽中機率 100%。轉盤只有一個選項等於產品主張不成立，且 App 沒有任何「候選過少、建議放寬條件」的提示就讓使用者走到投票與轉盤。需要產品決策：調預設值、依商圈動態調整、或加候選過少的引導。

- **ISSUE-007（Low）邀請碼錯誤橫幅不會消失** — 「房間不存在或已開始」在首頁一直停留到換路由，中間展開地圖、搜尋地點、切用餐時間、觸發另一則驗證訊息期間都還在，跟當下操作已無關。

- **ISSUE-009（Low）登入切註冊分頁會帶走密碼值** — Email 帶過去合理，密碼帶過去容易讓使用者在沒察覺下用一組錯的密碼建帳號。錯誤訊息本身有正確清掉。

### PR #17 明確延後的項目

- **`useRoom` 的 `room` 過期快照本體未修** — `useRoom.ts` 只在 `r.data` 為真時 `setRoom`，`rooms` 查詢失敗會保留舊物件、只亮 `loadError`。離席路徑已改成開 dialog 當場重查、不再讀它，但其他拿 `room.status` 做判斷的地方仍讀得到過期值。目前那些都是伺服器端會驗的寫入（會回明確錯誤而非靜默損壞），風險低但洞還在。若日後有本地端的不可逆判斷要讀 `room.status`，先補 `roomStale` 或改重查。

- **離席 dialog 沒有完整 focus trap** — 已用 `inert` 讓背景不可聚焦／不可觸發，但 Tab 到瀏覽器網址列再回來會落在 dialog 外。完整 top-layer 語意要改用原生 `<dialog showModal>`，代價是重做遮罩與動畫。

- **`room_members` 查詢沒有 `ORDER BY`** — 多房籍時 dialog 的房間顯示順序跟著 PostgREST 回傳順序走（同房的列仍由 `Map` 正確合併，只有多房的排列不保證）。要固定順序加一個 `.order('room_id')`。

- **`leaveConfirmed` 旗標路徑無 E2E** — 單元測試已覆蓋「消耗旗標」與「回到同一筆 entry 不重用」，但沒有真瀏覽器走查（需新增一條「房內按確認→首頁」）。

- **E2E 冷啟動 Realtime 待觀察（2026-10-11，`ci.yml` 的 `e2e` job）** — 2026-08-16 觀察到 `supabase start` 後首跑 `waitForRoomRealtime` 的 10 秒逾時撐不過 Realtime 首次訂閱。CI 在測試前先等一次訂閱成功並印出耗時：首次 CI（PR #44）暖身 2.2 秒、11/11 通過，本機冷啟動 1.6 秒。再看幾次 CI 的暖身耗時，穩定就結案。（用餐時間固定在午後 15:00／15:30，結果不隨執行時刻變動，見 `full-loop.spec.ts` 的 `mealTimeForE2E`。）

- **離席 dialog 的房籍清單在跨分頁競態下會過期**（PR #17 Codex review 2026-08-16，評估後不修）— dialog 開著時另一個分頁建房／加入，清單不會包含新房籍，但按下確認送出的 `/api/leave` 是以執行當下的房籍為準、全退，於是新房被靜默退掉且後果從沒顯示過。修法是「破壞性點擊當下重查，集合有變就要求再確認一次」。
  不修的理由：ADR-0007 Consequences 已裁定「多分頁開首頁會跳出離席確認；個人規模接受，不另做分頁互斥」，這條要求的正是分頁互斥。且它不是本 PR 造成的回歸——改動前是 mount 直接靜默全退、連 dialog 都沒有，現在只是清單可能過期，嚴格來說是變好而非變差。
  若日後改變「個人規模」的假設（多人常態同時開多分頁），連同 ADR 第 24 行一起重新裁定。

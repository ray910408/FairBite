# 系統不處理過敏原或食材級禁忌

Google Places 只提供菜系類別與粗粒度標籤（如 servesVegetarianFood），沒有過敏原、菜單或食材資料；「花生過敏 → 保證排除」與「不吃牛／豬 → 保證排除」都超出資料可證明的範圍。我們決定完全不做過敏功能，也不以餐廳類型推斷食材。條件設定只提供具正向 Places 證據的素食：餐廳必須有 `vegetarian_friendly` canonical tag 才保留；無正向證據一律排除。UI 不出現任何「已排除過敏或食材風險」的暗示。

## Rollout gate

Stage B1 的 app contract 是 Pages 只寫 `vegetarian`，Render 安全讀取並忽略舊 `no_beef`／`no_pork`；此時 pre-B2 DB constraint 仍相容地接受既有字串陣列。只有部署並驗證「Pages 不再產生舊值」且「Render 接受 legacy rows」後，才能進行 Stage B2 的清理與 constraint migration。沒有這份 deploy evidence，B2 一律 blocked。

## Considered options

- 兩層契約（tag 過濾 + 過敏警語不保證）— 仍會讓使用者誤信系統有在處理過敏，拒絕
- 菜系推斷過敏（海鮮過敏排除海鮮餐廳）— 隱藏過敏原必漏，承諾超過能力，拒絕
- 用餐廳類型推斷牛肉或豬肉（牛排、拉麵、港點等）— type 不是菜單／食材證據，拒絕

## Consequences

- 未來若要加回過敏功能，需要可靠的過敏原資料來源與法律免責設計，不是加一個欄位的事
- 未來若要處理食材級禁忌，需要可靠的菜單／食材來源；Google place types 不達 hard-exclusion 標準
- 相容期讀到舊 `no_beef`／`no_pork` 值時安全忽略，不把它們當作排除或嚴格檢索證據
- B2 migration 只能在 rollout gate 開啟後收緊 DB constraint；不能先遷移再部署相容 app
- 行銷/展示語言必須避免「安全」「保證」等字眼與過敏並列

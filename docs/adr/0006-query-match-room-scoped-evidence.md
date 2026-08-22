# 查詢命中是房間層證據，不改寫 canonical tags

2026-08-14 接受此決策。菜系檢索強化（Round 3）以 Places Text Search 依成員菜系定向召回。Google taxonomy
不夠細（例：拉麵店被標 noodle_shop 而無 ramen 類型），若只信 types 映射，定向召回
的店進了池也不加分、開過濾還會被踢掉；若直接把查詢結果寫進 restaurants.cuisine_tags，
搜尋相關性會被誤當成永久料理分類，且會隨快取汙染所有後續房間。
本 ADR 將查詢命中記在 room_candidates.query_matches（text[]，房間層），效力等同該店在本房
具備該菜系：偏好因素、滿足度樣本（memberLikes 單一命中定義，eng review D11）與菜系
過濾都吃它；restaurants.cuisine_tags 維持只來自 Google types 映射。primaryType/types
與查詢菜系明顯衝突時拒收該筆 match（條件式兩層防護，spec 決策 #9）。飲食禁忌維持
只看 canonical tags——query match 是相關性證據，非類型斷言。

## Considered options

- **LLM 分類（否決）**：每次搜尋都增加額外延遲與成本，模型分類還可能隨版本或提示漂移而無法重現；使用者已於 spec 2026-08-14 決策 #2 明確否決，採可重現的 Google Places Text Search。
- **店名關鍵字規則（否決）**：Text Search 已直接解決定向命中問題，名稱規則暫無必要；若日後發現通用池漏標再議（spec 2026-08-14 §9）。

## Consequences

- 麵框框類案例在本房被正確當拉麵計分；全域快取不被搜尋行為汙染。
- 快取 fallback（無查詢過程）query_matches 為空，降級模式只剩 types 加分（已接受）。
- 同一家店在不同房間可有不同菜系證據——這是特性不是 bug（房間各自的檢索脈絡）。
- LLM 分類與店名關鍵字規則的否決理由見上節；決策來源為 spec 2026-08-14 決策 #2 與 §9。

## Retrieval radius boundary

Nearby 與 Text Search 一律以 3000m、`rankPreference: "DISTANCE"` 向 Google 取回同一個 provider envelope；
解碼後再以呼叫端的房間半徑做 Haversine 硬過濾。因此，在同一份 Google 回應快照內，較小半徑的
本地結果是較大半徑結果的子集。這不保證跨不同時間的 Google 呼叫仍單調：Google 的排序與可回傳地點
會變動，重複搜尋可能得到不同快照。

## 2026-08-20 dessert 與 Taiwanese retrieval 邊界

`dessert` Text hit 採負向衝突閘門：只有 canonical `CuisineTags` 與 `HotMealCuisines`
相交才拒絕該筆 room-scoped match。它不要求 canonical dessert tag，所以 cafe 與通用
restaurant 的無衝突命中保留；被拒的是 evidence，不是 Nearby/general 候選，也不把 bakery
納入 meal gate。連鎖去重後同樣以留存分店的 canonical tags 重跑這個閘門。

Taiwanese retrieval 固定查 `台式料理` 與 `台灣小吃`，每詞最多兩頁、沒有 retry，故 Text
呼叫上限為四。page-one failure 跳過該詞 page two 但繼續另一詞；page-two failure 留住 page
one。空白、重複 token 或取消即停止，只有兩詞都沒有成功解碼頁面才回報 `taiwanese`
unfulfilled。`nextPageToken` 只列入 Text Search field mask；Nearby 保持原 mask。麵店／水餃
等召回仍只寫 `room_candidates.query_matches=["taiwanese"]`，絕不改寫 canonical tags。

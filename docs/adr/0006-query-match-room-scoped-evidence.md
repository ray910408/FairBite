# ADR-0006: 查詢命中（query match）是房間層證據，不改寫 canonical tags

## Status

Accepted (2026-08-14)

## Context

菜系檢索強化（Round 3）以 Places Text Search 依成員菜系定向召回。Google taxonomy
不夠細（例：拉麵店被標 noodle_shop 而無 ramen 類型），若只信 types 映射，定向召回
的店進了池也不加分、開過濾還會被踢掉；若直接把查詢結果寫進 restaurants.cuisine_tags，
搜尋相關性會被誤當成永久料理分類，且會隨快取汙染所有後續房間。

## Decision

查詢命中記在 room_candidates.query_matches（text[]，房間層），效力等同該店在本房
具備該菜系：偏好因素、滿足度樣本（memberLikes 單一命中定義，eng review D11）與菜系
過濾都吃它；restaurants.cuisine_tags 維持只來自 Google types 映射。primaryType/types
與查詢菜系明顯衝突時拒收該筆 match（條件式兩層防護，spec 決策 #9）。飲食禁忌維持
只看 canonical tags——query match 是相關性證據，非類型斷言。

## Consequences

- 麵框框類案例在本房被正確當拉麵計分；全域快取不被搜尋行為汙染。
- 快取 fallback（無查詢過程）query_matches 為空，降級模式只剩 types 加分（已接受）。
- 同一家店在不同房間可有不同菜系證據——這是特性不是 bug（房間各自的檢索脈絡）。
- 被 LLM 分類、店名關鍵字規則取代的路線見 spec 2026-08-14 決策 #2（皆否決）。

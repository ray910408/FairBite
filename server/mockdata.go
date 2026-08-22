package main

func daily(spans ...[2]int) OpeningHours {
	oh := OpeningHours{}
	for _, k := range weekdayKeys {
		oh[k] = append([][2]int{}, spans...)
	}
	return oh
}

// 這些是人工策展的具名店家，不是 Google 回應的模擬：tag 寫的是「這家店實際上是什麼」，
// 不必與 googleTypeTags 逐條對齊。noodle_shop 在 Google 那邊涵蓋台式麵店與拉麵店而不可
// 對映（googleTypesDeliberatelyUnmapped），但阿宗麵線與林東芳牛肉麵是不是台菜沒有懸念——
// 把已知事實刪掉只會讓無 API key 的本機模式勾「台式」選不到店（PR #18 codex review）。
var mockRestaurants = []Restaurant{
	{PlaceID: "mock-001", Name: "阿宗麵線", PrimaryType: "noodle_shop", CuisineTags: []string{"taiwanese", "noodle"}, PriceLevel: 0, Lat: 25.0466, Lng: 121.5076, Address: "萬華區峨眉街8-1號", Hours: daily([2]int{660, 1350}), Rating: 4.4},
	{PlaceID: "mock-002", Name: "一蘭拉麵", PrimaryType: "ramen_restaurant", CuisineTags: []string{"japanese", "ramen"}, PriceLevel: 2, Lat: 25.0455, Lng: 121.5170, Address: "中正區忠孝西路一段", Hours: daily([2]int{0, 1440}), Rating: 4.2},
	{PlaceID: "mock-003", Name: "金峰滷肉飯", PrimaryType: "restaurant", CuisineTags: []string{"taiwanese"}, PriceLevel: 0, Lat: 25.0440, Lng: 121.5130, Address: "中正區羅斯福路一段", Hours: daily([2]int{480, 1230}), Rating: 4.3},
	{PlaceID: "mock-004", Name: "添好運", PrimaryType: "dim_sum_restaurant", CuisineTags: []string{"cantonese"}, PriceLevel: 2, Lat: 25.0460, Lng: 121.5175, Address: "中正區忠孝西路一段36號", Hours: daily([2]int{600, 1290}), Rating: 4.1},
	{PlaceID: "mock-005", Name: "韓雞屋", PrimaryType: "korean_restaurant", CuisineTags: []string{"korean", "fried_chicken"}, PriceLevel: 2, Lat: 25.0495, Lng: 121.5210, Address: "中山區南京西路", Hours: daily([2]int{660, 1320}), Rating: 4.0},
	{PlaceID: "mock-006", Name: "慕里諾牛排館", PrimaryType: "steak_house", CuisineTags: []string{"western"}, PriceLevel: 4, Lat: 25.0500, Lng: 121.5150, Address: "大同區承德路一段", Hours: daily([2]int{690, 1260}), Rating: 4.5},
	{PlaceID: "mock-007", Name: "春天素食", PrimaryType: "vegetarian_restaurant", CuisineTags: []string{"vegetarian_friendly", "taiwanese"}, PriceLevel: 3, Lat: 25.0470, Lng: 121.5230, Address: "中正區忠孝東路一段", Hours: daily([2]int{690, 1230}), Rating: 4.2},
	{PlaceID: "mock-008", Name: "老四川麻辣鍋", PrimaryType: "hot_pot_restaurant", CuisineTags: []string{"hotpot"}, PriceLevel: 3, Lat: 25.0512, Lng: 121.5195, Address: "大同區南京西路", Hours: daily([2]int{1020, 120}), Rating: 4.4},
	{PlaceID: "mock-009", Name: "沙巴印度咖哩", PrimaryType: "indian_restaurant", CuisineTags: []string{"indian"}, PriceLevel: 1, Lat: 25.0430, Lng: 121.5190, Address: "中正區開封街一段", Hours: daily([2]int{660, 1260}), Rating: 4.1},
	{PlaceID: "mock-010", Name: "林東芳牛肉麵", PrimaryType: "noodle_shop", CuisineTags: []string{"taiwanese"}, PriceLevel: 1, Lat: 25.0478, Lng: 121.5260, Address: "中山區八德路二段", Hours: daily([2]int{660, 180}), Rating: 4.5},
	{PlaceID: "mock-011", Name: "早安美芝城", PrimaryType: "breakfast_restaurant", CuisineTags: []string{"breakfast", "taiwanese", "fast_food"}, PriceLevel: 0, Lat: 25.0485, Lng: 121.5140, Address: "大同區太原路", Hours: daily([2]int{330, 840}), Rating: 3.9},
	{PlaceID: "mock-012", Name: "藏壽司", PrimaryType: "sushi_restaurant", CuisineTags: []string{"japanese", "seafood"}, PriceLevel: 2, Lat: 25.0490, Lng: 121.5165, Address: "中正區市民大道一段", Hours: daily([2]int{660, 1320}), Rating: 4.0},
	{PlaceID: "mock-013", Name: "復興清粥小菜", PrimaryType: "restaurant", CuisineTags: []string{"taiwanese", "vegetarian_friendly"}, PriceLevel: 1, Lat: 25.0465, Lng: 121.5205, Address: "中正區忠孝東路一段", Hours: daily([2]int{0, 1440}), Rating: 4.0},
	{PlaceID: "mock-014", Name: "站前甜品屋", PrimaryType: "dessert_restaurant", CuisineTags: []string{"dessert"}, PriceLevel: 1, Lat: 25.0476, Lng: 121.5168, Address: "中正區忠孝西路一段", Hours: daily([2]int{660, 1320}), Rating: 4.3},
	{PlaceID: "mock-015", Name: "館前輕食吧", PrimaryType: "sandwich_shop", CuisineTags: []string{"light_meal"}, PriceLevel: 1, Lat: 25.0472, Lng: 121.5145, Address: "中正區館前路", Hours: daily([2]int{420, 1140}), Rating: 4.1},
}

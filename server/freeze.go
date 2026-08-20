package main

import (
	"context"
	"errors"
	"fmt"
	"slices"

	"github.com/jackc/pgx/v5"
)

// ErrMembersChanged：tx 內重讀發現成員條件已放寬（fetch envelope under-fetch），host 需重搜。
var ErrMembersChanged = errors.New("member conditions changed during search")

// ErrNotReady：非房主在 search preflight 後取消 ready；deferred rollback 留在 lobby。
var ErrNotReady = errors.New("guest not ready")

// 成員條件凍結（search 交易半場）——條件凍結不變式的 Go 半場唯一所在。
// SQL 半場（勿在別處重複解釋）：0001 members_update RLS 僅限 lobby + guard_room_columns
// 凍結 room 欄位、0003 擴充 guard 至 exploration、0005 is_room_lobby_locked 與
// rooms→members 的鎖序、0006 join_room 對 rooms 的 for update。
// 本函式在同一交易內：轉場 lobby→candidates（取得 room row lock、凍結生效）→
// 鎖序一致地重讀 exploration/meal_time/cuisine_filter 與成員（LoadMembersForUpdate 的 order by user_id 即鎖序 pin）→
// 對照 call-time fetchedRadius 收斂半徑：放大代表 fetch envelope under-fetch，回
// ErrMembersChanged 讓 host 重搜（deferred rollback 留在 lobby）；縮小則就地重濾 found。
// 圓心不在重讀之列：它是房主建房當下的位置，create_room 寫進去之後沒有任何路徑會改它，
// 搜尋期間不可能被挪走。
// 成功時就地更新 room.Exploration、room.MealTime 與 room.CuisineFilter 並回傳權威成員與存活的 found。
func freezeAndLoadMembers(ctx context.Context, tx pgx.Tx, room *RoomRow, fetchedRadius int, fetchedCuisines []string, found []Restaurant) ([]Member, []Restaurant, error) {
	// handleSearch 已由 assertHostInTx 取得 rooms row lock；TransitionRoom 沿用同一鎖，
	// 再由 LoadMembersForUpdate 依 user_id 取得 member locks（rooms → members）。
	if err := TransitionRoom(ctx, tx, room.ID, "lobby", "candidates"); err != nil {
		// ErrConflict 原樣透傳，呼叫端據以回 409。
		return nil, nil, err
	}
	// host_id 可能在 provider call 期間因房主離席而繼任；連同 lobby 可變設定一起鎖定後重讀。
	if err := tx.QueryRow(ctx,
		`select host_id, exploration, meal_time, cuisine_filter from rooms where id = $1`,
		room.ID).Scan(&room.HostID, &room.Exploration, &room.MealTime, &room.CuisineFilter); err != nil {
		return nil, nil, fmt.Errorf("凍結重讀 host_id/exploration/meal_time/cuisine_filter: %w", err)
	}
	members, err := LoadMembersForUpdate(ctx, tx, room.ID)
	if err != nil {
		return nil, nil, fmt.Errorf("凍結重讀成員: %w", err)
	}
	if len(members) == 0 {
		return nil, nil, fmt.Errorf("凍結重讀成員: 房間無成員")
	}
	if !allGuestsReady(members, room.HostID) {
		return nil, nil, ErrNotReady
	}
	// 檢索詞聯集在檢索後、凍結前被改動＝定向檢索 under-fetch（比照半徑放大的 ErrMembersChanged 語意）。
	// 菜系部分只在硬過濾開啟時阻斷：此時聯集是入池門檻，漏檢索的菜系會造成一次性池的永久漏召回；
	// 過濾關閉時菜系只是軟性加分，漏一支不會產生錯誤結果，回 409 只是白讓 host 重搜。
	// 嚴格禁忌部分不受此閘門限制：DietaryRequires 在 hardExclude 裡無條件生效，
	// 漏跑素食檢索就是該成員零候選（422 no_candidates），與 cuisine_filter 開關無關。
	// 但只看「新增」這一個方向：取消嚴格禁忌讓 envelope 變成安全的超集，不是 under-fetch。
	reloadedTerms := cuisineUnion(members)
	if !slices.Equal(reloadedTerms, fetchedCuisines) {
		dietaryDrifted := strictDietaryUnderFetched(reloadedTerms, fetchedCuisines)
		if room.CuisineFilter || dietaryDrifted {
			return nil, nil, ErrMembersChanged
		}
	}
	reloadedRadius := averageMemberRadius(members)
	// tx 內重讀的「全員平均距離」有三種情況：縮小則重濾、相等則直接繼續；
	// 放大代表先前的 fetch envelope under-fetch，回 ErrMembersChanged 並由 deferred rollback 留在 lobby，讓 host 重搜。
	// 半徑改取平均之後，這條放大分支比取最小值的年代更常走到：取最小值時新成員加入只可能把
	// 半徑壓小（新人的上限若更大，最小值不變），放大實質只有「既有成員自己調寬」一條路；
	// 取平均之後，任何一位上限高於現有平均的新成員加入就會把半徑推大。判斷本身沒變——
	// 半徑放大就是 under-fetch，重濾救不回來，只能請 host 重搜——變的是 409 的頻率。
	if reloadedRadius > fetchedRadius {
		return nil, nil, ErrMembersChanged
	}
	if reloadedRadius < fetchedRadius {
		withinReloadedRadius := found[:0]
		for _, restaurant := range found {
			if Haversine(room.CenterLat, room.CenterLng, restaurant.Lat, restaurant.Lng) <= float64(reloadedRadius) {
				withinReloadedRadius = append(withinReloadedRadius, restaurant)
			}
		}
		found = withinReloadedRadius
	}
	return members, found, nil
}

package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// ErrMembersChanged：tx 內重讀發現成員條件已放寬（fetch envelope under-fetch），host 需重搜。
var ErrMembersChanged = errors.New("member conditions changed during search")

// 成員條件凍結（search 交易半場）——條件凍結不變式的 Go 半場唯一所在。
// SQL 半場（勿在別處重複解釋）：0001 members_update RLS 僅限 lobby + guard_room_columns
// 凍結 room 欄位、0003 擴充 guard 至 exploration、0005 is_room_lobby_locked 與
// rooms→members 的鎖序、0006 join_room 對 rooms 的 for update。
// 本函式在同一交易內：轉場 lobby→candidates（取得 room row lock、凍結生效）→
// 鎖序一致地重讀 exploration、圓心與成員（LoadMembersForUpdate 的 order by user_id 即鎖序 pin）→
// 對照 call-time fetchedRadius 收斂半徑：放大代表 fetch envelope under-fetch，回
// ErrMembersChanged 讓 host 重搜（deferred rollback 留在 lobby）；縮小則就地重濾 found。
// 成功時就地更新 room.Exploration 並回傳權威成員與存活的 found。
func freezeAndLoadMembers(ctx context.Context, tx pgx.Tx, room *RoomRow, fetchedRadius int, found []Restaurant) ([]Member, []Restaurant, error) {
	if err := TransitionRoom(ctx, tx, room.ID, "lobby", "candidates"); err != nil {
		// ErrConflict 原樣透傳，呼叫端據以回 409。
		return nil, nil, err
	}
	// exploration 與 center_* 在 lobby 都可變（0015：新成員帶座標加入會重算中位數圓心），鎖定後重讀
	var centerLat, centerLng float64
	if err := tx.QueryRow(ctx,
		`select exploration, coalesce(center_lat, 0), coalesce(center_lng, 0) from rooms where id = $1`,
		room.ID).Scan(&room.Exploration, &centerLat, &centerLng); err != nil {
		return nil, nil, fmt.Errorf("凍結重讀 exploration: %w", err)
	}
	// 圓心被搜尋期間加入的成員挪走：已抓到的餐廳是繞舊圓心的 envelope，重濾也救不回來，
	// 和半徑放寬同樣處置——回 ErrMembersChanged 讓 host 重搜。
	if centerLat != room.CenterLat || centerLng != room.CenterLng {
		return nil, nil, ErrMembersChanged
	}
	members, err := LoadMembersForUpdate(ctx, tx, room.ID)
	if err != nil {
		return nil, nil, fmt.Errorf("凍結重讀成員: %w", err)
	}
	if len(members) == 0 {
		return nil, nil, fmt.Errorf("凍結重讀成員: 房間無成員")
	}
	reloadedRadius := minimumMemberRadius(members)
	// tx 內重讀的「全員最小距離」有三種情況：縮小則重濾、相等則直接繼續；
	// 放大代表先前的 fetch envelope under-fetch，回 ErrMembersChanged 並由 deferred rollback 留在 lobby，讓 host 重搜。
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
	// 凍結成立 → 精確座標不再需要，就地刪除。房間離開 lobby 後 join_room（只吃 lobby）
	// 不會再有人加入，而 recompute_room_center 全 repo 只有 join_room 一個 caller，
	// 這些每人一列的精確 GPS 之後永遠不會再被讀；rooms.center_* 已保有需要的聚合值。
	// 而 delete from rooms 只存在於測試，沒有 production 刪房路徑，不刪就是無限期留著。
	// 必須在同一個 tx：上面每條錯誤路徑（ErrConflict、ErrMembersChanged）都由呼叫端的
	// deferred rollback 把房間留在 lobby，刪除也得跟著回滾——否則房間還在 lobby 但座標
	// 沒了，下一次搜尋的圓心就錯了。也因此這段只能放在所有檢查通過之後。
	// 交叉檢查：日後若有人在 freeze 之後呼叫 recompute_room_center，空集合會走
	// `if v_ref is null then return`（0015），圓心原地不動，不會被清成 null。
	if _, err := tx.Exec(ctx, `delete from room_member_locations where room_id = $1`, room.ID); err != nil {
		return nil, nil, fmt.Errorf("凍結清除成員座標: %w", err)
	}
	return members, found, nil
}

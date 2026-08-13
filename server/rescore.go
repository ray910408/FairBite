package main

import (
	"context"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// rescoreRoom：重算（Rescore）— 投票/抽選前在同一交易內以當下成員、投票與
// 歷史狀態權威重算候選機率並落盤（ADR-0003 inline rescore、spec §5.5）。
// 僅供 vote/draw；search 的初次評分（外部餐廳、無票、成員 ForUpdate）不在此列。
// pre-tx room 設定可信：center_* 永凍、exploration 在 lobby 外由 guard_room_columns 凍結、meal_time 同受 guard 凍結。
// 回傳本次重算採用的成員快照，draw 的 RecordDecision 需要它。
func rescoreRoom(ctx context.Context, tx pgx.Tx, room RoomRow, wx *Weather) (EngineResult, []Member, error) {
	members, err := LoadMembers(ctx, tx, room.ID)
	if err != nil {
		return EngineResult{}, nil, fmt.Errorf("載入成員: %w", err)
	}
	if len(members) == 0 {
		return EngineResult{}, nil, fmt.Errorf("載入成員: 房間無成員")
	}
	rs, exposureCounted, err := LoadRoomRestaurants(ctx, tx, room.ID)
	if err != nil {
		return EngineResult{}, nil, fmt.Errorf("載入候選: %w", err)
	}
	votes, err := LoadVotes(ctx, tx, room.ID)
	if err != nil {
		return EngineResult{}, nil, fmt.Errorf("載入投票: %w", err)
	}
	recency, err := LoadRecency(ctx, tx, memberIDs(members), restaurantIDs(rs))
	if err != nil {
		return EngineResult{}, nil, fmt.Errorf("載入同席紀錄: %w", err)
	}
	// 順序不變式：LoadExposure → Evaluate（本檔內建構順序即保證，勿在中間插入寫入）
	exposure, err := LoadExposure(ctx, tx, memberIDs(members), restaurantIDs(rs))
	if err != nil {
		return EngineResult{}, nil, fmt.Errorf("載入曝光統計: %w", err)
	}
	satisfaction, err := LoadSatisfaction(ctx, tx, memberIDs(members))
	if err != nil {
		return EngineResult{}, nil, fmt.Errorf("載入滿足度: %w", err)
	}
	result := Evaluate(EngineInput{Restaurants: rs, Members: members,
		Now: roomEvalTime(room), CenterLat: room.CenterLat, CenterLng: room.CenterLng,
		Weather: wx, Votes: votes, Recency: recency, Exposure: exposure, ExposureCounted: exposureCounted,
		Satisfaction: satisfaction, Exploration: room.Exploration})
	// exposureCounted 從 LoadRoomRestaurants 到 Evaluate 到 ReplaceCandidates 全程同一份，round-trip 不外洩。
	if err := ReplaceCandidates(ctx, tx, room.ID, result, exposureCounted); err != nil {
		return EngineResult{}, nil, fmt.Errorf("寫入候選: %w", err)
	}
	return result, members, nil
}

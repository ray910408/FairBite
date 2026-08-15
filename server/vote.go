package main

import (
	"context"
	"errors"
	"fmt"

	"github.com/jackc/pgx/v5"
)

// castVote 錯誤模式：handler 據此對映 HTTP 狀態。
var (
	ErrNotMember         = errors.New("voter no longer a room member")
	ErrNotCandidate      = errors.New("restaurant not in room candidates")
	ErrVetoQuotaExceeded = errors.New("veto quota exceeded")
)

// VoteCommand：POST /vote 的領域命令內容（ADR-0003）。
type VoteCommand struct {
	RestaurantID string `json:"restaurant_id"`
	Kind         string `json:"kind"` // up|veto
	Op           string `json:"op"`   // cast|retract
}

// castVote：在呼叫端交易內執行投票命令的全部不變式——候選驗證、互斥
//（cast 某 kind 自動撤同店另一 kind）、否決限額（現存 veto ≤ VetoQuota）、
// 冪等寫入/收回——並回傳該成員剩餘否決額度。
// 前置：呼叫端已持有 room row lock 並驗過階段（TransitionRoom voting→voting）。
func castVote(ctx context.Context, tx pgx.Tx, roomID, uid string, cmd VoteCommand) (vetoesRemaining int, err error) {
	// 退房制（ADR-0007）後 membership 可能在 handler 的交易外檢查後消失：
	// 命令本體交易內權威重驗，杜絕已離席者的孤兒票（孤兒否決無人能收回，轉盤永久毒化）
	var isMember bool
	if err := tx.QueryRow(ctx, `select exists (select 1 from room_members
		where room_id = $1 and user_id = $2)`, roomID, uid).Scan(&isMember); err != nil {
		return 0, fmt.Errorf("驗證成員資格: %w", err)
	}
	if !isMember {
		return 0, ErrNotMember
	}

	var inRoom bool
	if err := tx.QueryRow(ctx, `select exists (select 1 from room_candidates
		where room_id = $1 and restaurant_id = $2)`, roomID, cmd.RestaurantID).Scan(&inRoom); err != nil {
		return 0, fmt.Errorf("驗證候選: %w", err)
	}
	if !inRoom {
		return 0, ErrNotCandidate
	}
	if cmd.Op == "cast" {
		other := "veto"
		if cmd.Kind == "veto" {
			other = "up"
		}
		if _, err := tx.Exec(ctx, `delete from votes
			where room_id = $1 and user_id = $2 and restaurant_id = $3 and kind = $4`,
			roomID, uid, cmd.RestaurantID, other); err != nil {
			return 0, fmt.Errorf("互斥撤票: %w", err)
		}
		if cmd.Kind == "veto" {
			// 排除同店：重複 cast 既有否決不吃額度
			var vetoes int
			if err := tx.QueryRow(ctx, `select count(*) from votes
				where room_id = $1 and user_id = $2 and kind = 'veto'
				  and restaurant_id <> $3`, roomID, uid, cmd.RestaurantID).Scan(&vetoes); err != nil {
				return 0, fmt.Errorf("計算否決額度: %w", err)
			}
			if vetoes >= VetoQuota {
				return 0, ErrVetoQuotaExceeded
			}
		}
		if _, err := tx.Exec(ctx, `insert into votes (room_id, user_id, restaurant_id, kind)
			values ($1, $2, $3, $4) on conflict do nothing`,
			roomID, uid, cmd.RestaurantID, cmd.Kind); err != nil {
			return 0, fmt.Errorf("寫票: %w", err)
		}
	} else { // retract：刪不存在的票也是成功（冪等）
		if _, err := tx.Exec(ctx, `delete from votes
			where room_id = $1 and user_id = $2 and restaurant_id = $3 and kind = $4`,
			roomID, uid, cmd.RestaurantID, cmd.Kind); err != nil {
			return 0, fmt.Errorf("收回: %w", err)
		}
	}
	var vetoes int
	if err := tx.QueryRow(ctx, `select count(*) from votes
		where room_id = $1 and user_id = $2 and kind = 'veto'`, roomID, uid).Scan(&vetoes); err != nil {
		return 0, fmt.Errorf("計算剩餘否決: %w", err)
	}
	return VetoQuota - vetoes, nil
}

package main

import (
	crand "crypto/rand"
	"encoding/binary"
	"encoding/hex"
	mrand "math/rand/v2"
	"sort"
)

func candKey(c Candidate) string {
	if c.Restaurant.ID != "" {
		return c.Restaurant.ID
	}
	return c.PlaceID
}

// Draw 以 crypto/rand 產生 seed，再用可重放的 PRNG 抽出 winner（spec §2 抽選可信度：seed 留存）
func Draw(kept []Candidate) (string, string) {
	var b [8]byte
	if _, err := crand.Read(b[:]); err != nil {
		panic(err) // 系統熵源失效屬致命錯誤
	}
	seedHex := hex.EncodeToString(b[:])
	return ReplayWinner(kept, seedHex), seedHex
}

func ReplayWinner(kept []Candidate, seedHex string) string {
	if len(kept) == 0 {
		return ""
	}
	b, err := hex.DecodeString(seedHex)
	if err != nil || len(b) != 8 {
		return ""
	}
	sorted := append([]Candidate{}, kept...)
	sort.Slice(sorted, func(i, j int) bool { return candKey(sorted[i]) < candKey(sorted[j]) })
	rng := mrand.New(mrand.NewPCG(binary.LittleEndian.Uint64(b), 0))
	x := rng.Float64()
	cum := 0.0
	for _, c := range sorted {
		cum += c.Probability
		if x < cum {
			return candKey(c)
		}
	}
	return candKey(sorted[len(sorted)-1]) // 浮點誤差保底
}

package main

import (
	crand "crypto/rand"
	"encoding/binary"
	"encoding/hex"
	mrand "math/rand/v2"
	"sort"
)

// Draw 以 crypto/rand 產生 seed，再用可重放的 PRNG 抽出 winner（spec §2 抽選可信度：seed 留存）。
// crypto/rand.Read 自 Go 1.24 起不回錯：熵源失效會直接終止程式。
func Draw(kept []Candidate) (string, string) {
	var b [8]byte
	crand.Read(b[:])
	seedHex := hex.EncodeToString(b[:])
	return ReplayWinner(kept, seedHex), seedHex
}

// ReplayWinner：kept 非空、seedHex 是 Draw 產生的 16 位 hex（呼叫端保證：抽選與重轉都先擋掉零候選）。
func ReplayWinner(kept []Candidate, seedHex string) string {
	b, _ := hex.DecodeString(seedHex)
	sorted := append([]Candidate{}, kept...)
	sort.Slice(sorted, func(i, j int) bool { return rkey(sorted[i].Restaurant) < rkey(sorted[j].Restaurant) })
	rng := mrand.New(mrand.NewPCG(binary.LittleEndian.Uint64(b), 0))
	x := rng.Float64()
	cum := 0.0
	for _, c := range sorted {
		cum += c.Probability
		if x < cum {
			return rkey(c.Restaurant)
		}
	}
	return rkey(sorted[len(sorted)-1].Restaurant) // 浮點誤差保底
}

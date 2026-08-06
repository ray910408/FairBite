package main

import (
	"math"
	"testing"
)

func cands(ps ...float64) []Candidate {
	out := make([]Candidate, len(ps))
	for i, p := range ps {
		out[i] = Candidate{Restaurant: Restaurant{PlaceID: string(rune('a' + i))}, Probability: p}
	}
	return out
}

func TestDrawReplayDeterministic(t *testing.T) {
	ks := cands(0.5, 0.3, 0.2)
	winner, seed := Draw(ks)
	if seed == "" {
		t.Fatal("seed 不可為空")
	}
	for i := 0; i < 10; i++ {
		if got := ReplayWinner(ks, seed); got != winner {
			t.Fatalf("replay 不一致：%s vs %s", got, winner)
		}
	}
}

func TestDrawEmptyCandidates(t *testing.T) {
	if w, seed := Draw(nil); w != "" || seed == "" {
		t.Fatalf("空清單應回空 winner 與非空 seed，got %q %q", w, seed)
	}
}

func TestDrawDistribution(t *testing.T) {
	ks := cands(0.5, 0.3, 0.2)
	counts := map[string]int{}
	const n = 100000
	for i := 0; i < n; i++ {
		w, _ := Draw(ks)
		counts[w]++
	}
	for i, want := range []float64{0.5, 0.3, 0.2} {
		got := float64(counts[string(rune('a'+i))]) / n
		if math.Abs(got-want) > 0.015 {
			t.Errorf("候選 %c：期望 %.2f，實際 %.4f", 'a'+i, want, got)
		}
	}
}

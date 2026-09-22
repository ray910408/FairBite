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

func TestDraw(t *testing.T) {
	for _, tc := range []struct {
		name       string
		candidates []Candidate
		wantEmpty  bool
	}{
		{"weighted candidates replay deterministically", cands(0.5, 0.3, 0.2), false},
		{"empty candidates retain a seed", nil, true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			winner, seed := Draw(tc.candidates)
			if seed == "" || (winner == "") != tc.wantEmpty {
				t.Fatalf("Draw = (%q, %q)", winner, seed)
			}
			for i := 0; i < 10; i++ {
				if got := ReplayWinner(tc.candidates, seed); got != winner {
					t.Fatalf("replay = %q, want %q", got, winner)
				}
			}
		})
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

package main

import (
	"context"
	"fmt"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

// History scoring applies below and at the former four-member boundary.
func TestHistoryScoringAllRoomSizes(t *testing.T) {
	for n := 1; n <= 4; n++ {
		for _, gear := range []struct {
			name              string
			recency, exposure float64
		}{
			{"familiar", 0.65, 1.0},
			{"balanced", 0.3, 0.9},
			{"explore", 0.3, 0.85},
		} {
			t.Run(fmt.Sprintf("%d/%s", n, gear.name), func(t *testing.T) {
				in := EngineInput{Restaurants: []Restaurant{rest(nil), rest(func(r *Restaurant) {
					r.PlaceID = "other"
					r.CuisineTags = []string{"taiwanese"}
				})}, Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170, Exploration: gear.name}
				for i := 0; i < n; i++ {
					in.Members = append(in.Members, member(func(m *Member) {
						m.UserID = fmt.Sprint(i)
						if i > 0 {
							m.Cuisines = []string{"taiwanese"}
						}
					}))
				}
				without := Evaluate(in)
				in.Recency = map[string]RecencyCount{"p1": {Fresh: n}}
				in.Exposure = map[string]ExposureCount{"p1": {Recommended: 5 * n, Chosen: 5 * n}}
				withHistory := Evaluate(in)
				traces := map[string]TraceEntry{}
				for _, trace := range withHistory.Kept[0].Trace {
					traces[trace.Factor] = trace
				}
				if got := traces["recency"].Mult; math.Abs(got-gear.recency) > 1e-9 {
					t.Fatalf("recency = %v, want %v", got, gear.recency)
				}
				if trace, ok := traces["exposure"]; gear.name == "familiar" {
					if ok {
						t.Fatalf("familiar must keep chosen penalty disabled: %+v", trace)
					}
				} else if !ok || math.Abs(trace.Mult-gear.exposure) > 1e-9 {
					t.Fatalf("exposure = %+v, want %v", trace, gear.exposure)
				}
				if withHistory.Kept[0].Score >= without.Kept[0].Score ||
					withHistory.Kept[0].Probability >= without.Kept[0].Probability {
					t.Fatal("history penalties must lower both score and probability")
				}
				in.Satisfaction = map[string]float64{}
				for _, m := range in.Members {
					in.Satisfaction[m.UserID] = 0.9
				}
				in.Satisfaction["0"] = 0.1
				withFairness := Evaluate(in)
				if n == 1 {
					if !reflect.DeepEqual(withHistory, withFairness) {
						t.Fatal("one member has no satisfaction gap to correct")
					}
				} else if withFairness.Kept[0].Score <= withHistory.Kept[0].Score ||
					withFairness.Kept[0].Probability <= withHistory.Kept[0].Probability {
					t.Fatal("fairness must boost the least satisfied member's preference")
				}
			})
		}
	}
}

func TestExcludedReasonHasByteBound(t *testing.T) {
	for _, tc := range []struct {
		name string
		veto bool
	}{{"dietary", false}, {"veto", true}} {
		t.Run(tc.name, func(t *testing.T) {
			veto := tc.veto
			in := EngineInput{Restaurants: []Restaurant{rest(nil)}, Now: lunchMonday}
			for i := 0; i < 20; i++ {
				in.Members = append(in.Members, member(func(m *Member) {
					m.DisplayName = strings.Repeat("名", 80)
					if !veto {
						m.Dietary = []string{"vegetarian"}
					}
				}))
			}
			if veto {
				in.Votes = map[string]VoteInfo{"p1": {Vetoers: []string{strings.Repeat("名", 10000)}}}
			}
			result := Evaluate(in)
			if len(result.Excluded) != 1 {
				t.Fatal("expected exclusion")
			}
			reason := result.Excluded[0].Reason
			if len(reason) > 2048 || !utf8.ValidString(reason) || !strings.HasSuffix(reason, "…") {
				t.Fatalf("veto=%v: invalid bounded UTF8 reason (%d bytes)", veto, len(reason))
			}
		})
	}
}

func TestGroupHistoryTraceHasNoExactCounts(t *testing.T) {
	in := recencyIn(RecencyCount{Fresh: 1, Fading: 2}, "balanced", 4)
	in.Exposure = map[string]ExposureCount{"p1": {Recommended: 9, Chosen: 3}}
	for _, trace := range Evaluate(in).Kept[0].Trace {
		if trace.Factor != "recency" && trace.Factor != "exposure" {
			continue
		}
		if strings.ContainsAny(trace.Reason, "0123456789") {
			t.Fatalf("exact history count in shared trace: %+v", trace)
		}
	}
}

func TestGroupHistoryUsesCoarseBuckets(t *testing.T) {
	in := recencyIn(RecencyCount{Fresh: 1}, "balanced", 4)
	in.Exposure = map[string]ExposureCount{"p1": {Recommended: 30, Chosen: 5}}
	first := Evaluate(in)
	in.Recency["p1"] = RecencyCount{Fresh: 2}
	in.Exposure["p1"] = ExposureCount{Recommended: 30, Chosen: 10}
	if !reflect.DeepEqual(first, Evaluate(in)) {
		t.Fatal("exact counts leaked within the same group history bucket")
	}
}

// Execute the actual migration against seeded old snapshots in a rollback-only
// transaction. Rename only its archive schema to coexist with the applied schema.
func TestLegacyScoringMigrationPreservesPrivateAudit(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool := newTestPool(t, ctx)
	tx, err := pool.Begin(ctx)
	if err != nil {
		t.Fatal(err)
	}
	defer tx.Rollback(context.Background())
	_, err = tx.Exec(ctx, `
		insert into auth.users(id,email) values ('27100000-0000-0000-0000-000000000001','privacy-migration@test.dev');
		insert into rooms(id,host_id,status) values
		 ('27100000-0000-0000-0000-000000000010','27100000-0000-0000-0000-000000000001','decided'),
		 ('27100000-0000-0000-0000-000000000011','27100000-0000-0000-0000-000000000001','voting');
		insert into restaurants(id,place_id,name,lat,lng,source) values
		 ('27100000-0000-0000-0000-000000000020','privacy-migration','test',25,121,'mock');
		insert into room_candidates(room_id,restaurant_id,status,probability,weight_breakdown) values
		 ('27100000-0000-0000-0000-000000000010','27100000-0000-0000-0000-000000000020','kept',0.37,'[{"factor":"recency","mult":0.3,"reason":"1 private visit"}]'),
		 ('27100000-0000-0000-0000-000000000011','27100000-0000-0000-0000-000000000020','kept',0.42,'[{"factor":"preference","mult":1.2,"reason":"fairness"}]');
		insert into draws(id,room_id,version,seed,winner_restaurant_id,probabilities) values
		 ('27100000-0000-0000-0000-000000000030','27100000-0000-0000-0000-000000000010',1,'original-seed','27100000-0000-0000-0000-000000000020','{"27100000-0000-0000-0000-000000000020":0.37}');
		create temporary table original_candidates as select * from room_candidates;
		create temporary table original_draws as select * from draws;`)
	if err != nil {
		t.Fatal(err)
	}
	migration, err := os.ReadFile("../supabase/migrations/20260905000300_private_scoring_snapshots.sql")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = tx.Exec(ctx, strings.ReplaceAll(string(migration), "private_scoring", "privacy_migration_test")); err != nil {
		t.Fatal(err)
	}
	var valid bool
	if err = tx.QueryRow(ctx, `select
		 not exists (select 1 from original_candidates c full join privacy_migration_test.legacy_room_candidates a using (room_id,restaurant_id) where to_jsonb(c) is distinct from to_jsonb(a))
		 and not exists (select 1 from original_draws d full join privacy_migration_test.legacy_draws a using (id) where to_jsonb(d) is distinct from to_jsonb(a))
		 and not exists (select 1 from room_candidates where probability is not null or weight_breakdown <> '[]')
		 and not exists (select 1 from draws d join original_draws o using(id) where d.probabilities <> '{}' or d.seed <> o.seed or d.winner_restaurant_id <> o.winner_restaurant_id)
		 and not has_schema_privilege('authenticated','privacy_migration_test','usage')
		 and not has_table_privilege('authenticated','privacy_migration_test.legacy_draws','select')`).Scan(&valid); err != nil {
		t.Fatal(err)
	}
	if !valid {
		t.Fatal("legacy archive/redaction did not preserve the original audit or protect shared snapshots")
	}
}

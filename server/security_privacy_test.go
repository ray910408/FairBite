package main

import (
	"context"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/jackc/pgx/v5/pgxpool"
)

// Keep integration history tests above the privacy threshold using real, unique
// members with the same current preferences, never duplicate Member IDs.
func addHistoryScoringPeers(t *testing.T, ctx context.Context, pool *pgxpool.Pool, roomIDs ...string) {
	t.Helper()
	// These fixtures reuse a host ID across test runs; quota behavior has its own
	// tests and must not make repeated history-ordering checks state-dependent.
	if _, err := pool.Exec(ctx, `delete from account_resource_usage where user_id in
		(select host_id from rooms where id=any($1::uuid[]))`, roomIDs); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 3; i++ {
		var uid string
		if err := pool.QueryRow(ctx, `insert into auth.users(id) values(gen_random_uuid()) returning id`).Scan(&uid); err != nil {
			t.Fatal(err)
		}
		t.Cleanup(func() { pool.Exec(context.Background(), `delete from auth.users where id=$1`, uid) })
		if _, err := pool.Exec(ctx, `insert into room_members(room_id,user_id,budget_max,cuisines,dietary,max_distance_m,transport,ready)
			select r.id,$1,m.budget_max,m.cuisines,m.dietary,m.max_distance_m,m.transport,true
			from rooms r join room_members m on m.room_id=r.id and m.user_id=r.host_id
			where r.id=any($2::uuid[])`, uid, roomIDs); err != nil {
			t.Fatal(err)
		}
	}
}

// Shared score, probability and trace must ALL be independent of private history
// below the minimum group size, not merely hide names in the explanation.
func TestSmallGroupPrivateHistoryNoninterference(t *testing.T) {
	for n := 1; n < 4; n++ {
		t.Run(fmt.Sprint(n), func(t *testing.T) {
			in := EngineInput{Restaurants: []Restaurant{rest(nil), rest(func(r *Restaurant) {
				r.PlaceID = "other"
				r.CuisineTags = []string{"taiwanese"}
			})}, Now: lunchMonday, CenterLat: 25.0478, CenterLng: 121.5170}
			for i := 0; i < n; i++ {
				in.Members = append(in.Members, member(func(m *Member) {
					m.UserID = fmt.Sprint(i)
					if i > 0 {
						m.Cuisines = []string{"taiwanese"}
					}
				}))
			}
			without := Evaluate(in)
			in.Recency = map[string]RecencyCount{"p1": {Fresh: 1, Fading: 2}}
			in.Exposure = map[string]ExposureCount{"p1": {Recommended: 100, Chosen: 20}}
			in.Satisfaction = map[string]float64{"0": 0.1, "1": 0.9, "2": 0.8}
			for _, gear := range []string{"familiar", "balanced", "explore"} {
				in.Exploration = gear
				if got := Evaluate(in); !reflect.DeepEqual(got, without) {
					t.Fatalf("%s: private history changed shared output\nwithout=%+v\nwith=%+v", gear, without, got)
				}
			}
		})
	}
}

func TestExcludedReasonHasByteBound(t *testing.T) {
	for _, veto := range []bool{false, true} {
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
	dsn := os.Getenv("TEST_DATABASE_URL")
	if dsn == "" {
		t.Skip("TEST_DATABASE_URL not set")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
	defer cancel()
	pool, err := pgxpool.New(ctx, dsn)
	if err != nil {
		t.Fatal(err)
	}
	defer pool.Close()
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
		insert into draws(id,room_id,seed,winner_restaurant_id,probabilities) values
		 ('27100000-0000-0000-0000-000000000030','27100000-0000-0000-0000-000000000010','original-seed','27100000-0000-0000-0000-000000000020','{"27100000-0000-0000-0000-000000000020":0.37}');
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

-- Deploy with the k=4 scoring server: old scoring inputs cannot be reconstructed
-- reliably, and rewriting old odds would break their seed/replay audit.
-- Preserve originals server-only before redacting every shared legacy snapshot,
-- including decided rooms and rooms whose membership changed since the draw.
-- Migration runner must execute this transactionally; block concurrent snapshot
-- writers so the archive and redaction refer to the same complete old state.
lock table public.room_candidates, public.draws in share row exclusive mode;
create schema private_scoring;
revoke all on schema private_scoring from public, anon, authenticated, service_role;

create table private_scoring.legacy_room_candidates as
  select * from public.room_candidates;
create table private_scoring.legacy_draws as
  select * from public.draws;
alter table private_scoring.legacy_room_candidates enable row level security;
alter table private_scoring.legacy_draws enable row level security;
revoke all on all tables in schema private_scoring from public, anon, authenticated, service_role;

-- NULL / {} means unavailable, never a fabricated zero/equal-probability draw.
-- Winner and seed are unchanged. The full original audit remains in the archive.
update public.room_candidates set probability = null, weight_breakdown = '[]';
update public.draws set probabilities = '{}';

# NCAA paper-data gathering via a config-driven league scan

Single-league assumption removed: on 2026-11-02 the scanner gained a second
league — NCAA — for the sole purpose of harvesting odds into `paper_bets`
tagged `league='NCAA'` so a strategy can be developed before any real betting,
mirroring the NBA arc. This is a data-gathering increment only: no real bets,
no automated NCAA settlement, no home/portfolio/analytics changes.

## Context

The whole pipeline today is implicitly NBA. `fetch_danske_spil` hardcodes the
Danske Spil tag 18608 and stamps `league: "NBA"`; `fetch_pinnacle_cached` pulls
spread-only Pinnacle odds from The Odds API (`sports/basketball_nba`); the
scores fetch and `grade_bet` settle NBA only. The data model already anticipated
other leagues: `paper_bets.league` exists (with a migration), `run_analysis`
passes `league` through, `log_paper_bets` stores it, and the Paper Trading page
already filters by a data-derived League dropdown — so the read surface needs no
change.

Pinnacle closed its public API on 2025-07-23; the project now uses pinnapi.com
as the replacement sharp-odds feed (basketball is sport_id=3 and includes NBA +
NCAA + more). Danske Spil exposes NCAA under tag 18615.

## Decision

- **Two-league, config-driven scan.** Introduce a per-league config object
  (danske tag, danske window, pinnacle provider, pinnacle sport + league
  filter, market scope, score source) and have `run_scheduled_scan` iterate
  NBA then NCAA. No copy-pasted pipeline.
- **NCAA Pinnacle source = pinnapi** (`/kit/v1/markets?sport_id=3&event_type=prematch`),
  reading `PINNAPI_KEY` from env. **NBA stays on The Odds API** (`API_KEY`) for
  continuity. A per-league "pinnacle provider" selector is the seam to migrate
  NBA later.
- **NCAA Danske Spil** = tag 18615, full-season window 2026-11-01 .. 2027-05-31,
  exclusions 20769/22796/22797, `maxEvents=64`, each event stamped
  `league='NCAA'`.
- **Filter pinnapi to NCAA** by a config-driven `league_name` allowlist, with a
  one-time distinct-`league_name` logger so the allowlist is tuned from the real
  feed rather than guessed (pinnapi does not enumerate its league labels).
- **Two-layer team matching.** Normalize names on both sides plus a persistent
  alias map, and match on the full `"Home vs Away"` string with a higher
  threshold; log matched and unmatched pairs so the map grows from real data.
  Single-token fuzzy matching is unsafe across ~350 NCAA teams (shared
  "Cowboys/Tigers/State/Texas" colliders and Danish-book spelling variants).
- **Market scope = money_line + spread + total** for NCAA (from pinnapi
  `num_0`), richer than NBA's spread-only pull. A pinnapi→"outcomes" adapter
  normalizes the shape so `run_analysis` / `calculate_fair_probability` /
  CLV helpers work unchanged.
- **Settlement deferred.** No NCAA scores source is wired in this phase; NCAA
  paper bets accumulate as raw odds + closing-line snapshots only.
- **League-scope the correctness paths.** Add `league` to `market_snapshots`
  and filter the CLV lookup by the bet's league (today it takes the latest
  snapshot before game start regardless of league, which interleaved NBA/NCAA
  snapshots would corrupt). Add a league filter to strategy analysis so NBA
  and NCAA are never mixed.
- **No frontend changes.** The existing Paper Trading league dropdown surfaces
  NCAA automatically.

## Consequences

- The heartbeat now scans two leagues each run; one pinnapi prematch pull per
  scan is safe against pinnapi's quota at the current 90-minute cadence.
- Data model additions: `market_snapshots.league` (migration like the others);
  `/api/strategy-analysis` gains a league param; optionally the paper-bets
  limit becomes league-scoped.
- `PINNAPI_KEY` must be present in the backend container env — i.e. added to
  `/opt/appdata/market-scanner/.env` (the repo-root `.env.local` is not read by
  the container). Added 2026-11-02.
- Impact surface is the paper-read path only. `bets`, portfolio, analytics and
  the home opportunities view stay NBA-scoped and untouched in this phase.
- Verification is read-only: `/api/paper-bets` shows NCAA rows and the UI
  dropdown lists NCAA; do not use the side-effecting `/api/opportunities` to
  verify.

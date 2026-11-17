# Date-keyed, final-only settlement for NBA + NCAA paper bets

Settlement reworked on 2026-11-17 from a fragile string match into per-league,
date-keyed, final-only score connectors, and the deferred NCAA settlement
(ADR-0002) is lifted: NCAA paper bets now grade against a self-hosted NCAA
scores API once the connector is implemented. This ADR records the agreed
design; it is the reference the implementation lands against.

## Context

Today's only settlement path is NBA. `grade_bet` joins every game returned over
the last 3 days into `"Home vs Away"` titles and runs
`thefuzz.process.extractOne(bet.match_name, all_titles)` with a threshold of 90,
checking `completed` only afterwards:

- **No game day.** `extractOne` picks whichever entry scores highest on string
  similarity, so a back-to-back or repeated same-team matchup within the 3-day
  window (or a live sibling game) can win over the bet's actual game — the
  wrong *day's* score is graded.
- **No final-only gate before matching.** The Odds API fallback returns
  in-progress games (`completed: false`) as candidates, so a live score can be
  grabbed.
- **Fragile title assumption.** Matching assumes both sides spell
  `"Home vs Away"`. Studio/venue data sources that order or delimit teams
  differently (e.g. the NCAA API's `title`, which is `"Away Home"` with no
  separator) break it.
- **No ambiguity rejection.** If two candidates tie, it takes `extractOne`'s
  winner and silently guesses.

NCAA is wired in ADR-0002 as a scan league with `score_source: None`
("settlement deferred this phase"), so NCAA paper bets accumulate odds and
closing lines but are never graded.

Settlement cadence is `hour=5` in `TZ=Europe/Copenhagen`; in winter that is
05:00 CET = 23:00 ET the prior evening — *mid-evening game time* on the US East
Coast, when most NBA/NCAA games are not yet final.

## Decision

- **One generalized settlement path.** Settlement becomes per-league **score
  connectors** behind the existing per-league `score_source` seam. A connector
  takes `(home, away, commence_time)` and returns the *final score for that one
  specific game*, disambiguated by game day and final-only. `grade_bet`'s
  MoneyLine / Spread / Total grading math is unchanged.
- **Matching contract (both leagues).** Grade a bet only when **exactly one**
  finished game matches on (a) game day derived from the bet's `commence_time`
  in **America/New_York** (both the current NBA and new NCAA paths use ET; the
  wall-clock settlement gate stays Europe/Copenhagen), (b) both team names via
  the canonical alias map, (c) a start-time tolerance window. **Zero or more
  than one candidate ⇒ keep `Pending` and log — never `extractOne`-guess.**
- **NBA connector.** Primary = `leaguegamefinder` scoped to the bet's date,
  cross-checked on `GAME_DATE`. Fallback = The Odds API scores filtered by
  per-game `commence_time` date and `completed`.
- **NCAA connector (`score_source: "ncaa"`).** Fetch
  `/scoreboard/basketball-men/d1/{Y}/{M}/{D}` for the bet's game day, keep only
  games with `gameState == "final"` / `finalMessage == "FINAL"`, and match the
  bet's two teams by their canonical **seo slug** (seeded from
  `/schools-index`) plus a start-time window on `startTimeEpoch`. Any
  non-`final` state — `live`, `postponed`, `canceled` — ⇒ **`Pending`**, never
  auto-graded.
- **NCAA API self-hosted.** Add service `ncaa-api` (`henrygd/ncaa-api`) to the
  repo-root `docker-compose.yml` on `market-net` so the backend reaches it by
  service DNS at `http://ncaa-api:3000`. Publish `127.0.0.1:3000:3000`
  loopback-only for host side verification; it must **not** join `proxy-net` and
  must not be publicly reachable. Covers NCAA men's d1 — assumed correct for
  Danske Spil tag 18615 / pinnapi `NCAA` allowlist; adapt division/sex if the
  feed later shows otherwise.
- **Cadence.** Replace the single 05:00 daily cron with an **idempotent run
  every 4 hours** (APScheduler interval). A run only fetches scoreboards for
  game-days that still have `Pending` bets; no finals in a window ⇒ no-op.
  Already-graded bets are skipped, so repeated runs are safe. This no longer
  depends on firing after the slate is final, because every run is final-only
  and cheap.
- **Canceled/postponed surfacing.** Never grade as a loss. Keep `status =
  Pending` but set `result_score` to a self-describing review marker
  (`"Canceled/Postponed — manual review"`) and log it, so it surfaces in the
  Paper Trading UI as needing a human decision rather than being forgotten.
- **NCAA settlement lifted; still paper-only.** NCAA game outcomes settle, but
  NCAA remains a paper-bets-only league (ADR-0002) — no real bets, portfolio or
  analytics changes.

## Consequences

- `docker-compose.yml` gains an `ncaa-api` service and `deploy.sh` gains a
  loopback smoke check for it (`http://127.0.0.1:3000/scoreboard/basketball-men/d1`);
  `./deploy.sh` pulls the image on first deploy (no `build:` key, so the app
  images are not rebuilt).
- The daily 05:00 cron (`daily_settlement`) is replaced by a 4-hourly
  idempotent settlement job; the heartbeat scan clock is untouched.
- Settlement now needs a network request per distinct game-day with Pending
  bets; the self-hosted NCAA instance removes the public demo instance's rate
  limit and availability from a correctness-critical path. The NBA
  `leaguegamefinder` path is unchanged in shape.
- `grade_bet` matching behavior changes (date-first, final-only,
  ambiguity-safe); existing `bets`-table (`/api/settle-bets`) and
  `paper_bets` flows both route through the reworked match, so NBA settlement
  becomes more conservative (never guesses) rather than more aggressive.
- The NCAA API's JSON is undocumented in its OpenAPI spec
  (`components.schemas` is empty) and mirrors ncaa.com's internal feed, which
  can drift. The connector pins a response contract with a small validator and
  treats schema drift as a loud, logged failure (bets stay `Pending`), never a
  silent misgrade.

## Status

Decision agreed 2026-11-17. ADR recorded before implementation; the code,
compose service, schedule change and deploy are a separate handoff to a fresh
agent instance.
# EuroLeague as a paper-data-only league

The scanner gains a third league — EuroLeague — mirroring the NCAA arc. Like
NCAA it is **paper-data-only**: it harvests odds into `paper_bets` tagged
`league='EuroLeague'` and settles those paper bets to a final score, but it
never notifies, never places real bets, and does not touch the home / portfolio
/ analytics surfaces (all still NBA-scoped).

## Context

The pipeline is config-driven over `LEAGUES[]` (ADR-0002) with per-league score
connectors behind each league's `score_source` key (ADR-0003). NBA scans a
rolling 24 h window and notifies; NCAA scans a fixed full-season window,
paper-only, with no notify.

Evaluating a European basketball strategy needs odds and outcomes for the
EuroLeague's ~Oct → May season at a comparable resolution to NCAA. The pieces
already line up:

- **Danske Spil exposes EuroLeague under tag 23192** (verified: returns the
  current EuroLeague fixtures).
- **Pinnapi already returns "Europe - Euroleague"** under the single
  `sport_id=3` basketball request the scanner already makes, so adding the
  league costs no extra pinnapi quota. It shows up in the one-time
  distinct-league_name logger output from past runs.
- **Official final scores come from `api-live.euroleague.net`** — a no-auth XML
  endpoint (`/v1/results?seasonCode=E2026`) that lists the whole season's
  `played=true` games with hometeam, homescore, awayteam, awayscore, date,
  time, gamecode and gamenumber. Confirmed live: E2026 (the *current* season,
  NOT the finished E2025) contains 140 games including the exact fixtures from
  the Danske slate (e.g. Olympiacos 104-79 Hapoel, Real Madrid 108-93 Zalgiris).

## Decision

- **New "EuroLeague" entry in `LEAGUES[]`**, shaped exactly like NCAA:
  paper-only (`notify: False`), fixed full-season window
  `2026-10-01 .. 2027-06-30`, Danske tag 23192, pinnapi `sport_id=3`
  `event_type=prematch`, `league_name_allowlist: ["Europe - Euroleague"]`,
  markets money_line/spread/total, `match_strategy: "full_string"`, and a
  `score_source: "euroleague"`.
- **EuroLeague score connector (`score_source: "euroleague"`).** A new
  `_euroleague_connector(home, away, commence_time)` mirrors the NCAA/NBA
  pattern: fetch the current-season results XML once per settlement run
  (cached via a run-scoped `_euroleague_results_cache`, reset with
  `_reset_settlement_caches()`), keep only `played=true` games, map both bet
  teams through a persistent alias map to the official feed spellings, and
  return the **final score for exactly one game** matching both teams plus a
  start-time window (±6 h). **Zero or more than one finished candidate ⇒ keep
  `Pending` and log — never a fuzzy-string guess.**
- **Alias map (book → feed).** The feed strings are UPPERCASE and group teams
  differently from the books (e.g. `HAPOEL IBI TEL AVIV` vs book "Hapoel Tel
  Aviv", `FENERBAHCE TARFIN ISTANBUL` vs "Fenerbahce Istanbul"). A
  `EURO_LEAGUE_TEAM_NAME_MAP` maps normalized Danske/Pinnacle spellings to the
  official feed team strings for the 2026-27 field of 20 clubs; matching is
  exact on both normalized keys (case folding via the existing
  `normalize_team_name`).
- **No canceled/postponed auto-grading.** The EuroLeague results endpoint has
  no explicit canceled flag — a non-played game is simply absent (or
  `played=false`). A game that never reaches `played=true` never becomes a
  final candidate, so the bet stays `Pending`; the existing `CANCELED_MARKER`
  path (ADR-0003) is not engaged for EuroLeague because the feed does not
  distinguish postponed from not-yet-played.
- **Frontend strategy league selector** gains "EuroLeague" (`LEAGUE_OPTIONS` →
  `["NCAA", "NBA", "EuroLeague"]`). The paper-trading filter derives leagues
  from stored bets, so its dropdown picks EuroLeague up automatically.
- **No new dependencies.** The connector uses the Python stdlib
  `xml.etree.ElementTree` and the existing `requests` + `pytz` already
  imported for the other connectors.

## Consequences

- The heartbeat scans a third league each run. The one extra Danske event-list
  call is free; pinnapi needs no extra request (EuroLeague is already in the
  `sport_id=3` payload behind the existing allowlist logger).
- EuroLeague paper bets grade to final scores once games finish, making the
  strategy-analysis surface (`/api/strategy-analysis` league param) meaningful
  for European basketball.
- Settlement stays read-only and ambiguity-safe: no real bets, no notifications,
  no portfolio/analytics changes; non-EuroLeague paths are untouched.
- The `seasonCode` is pinned to E2026; a new season requires bumping
  `EUROLEAGUE_RESULTS_URL` (or the `EUROLEAGUE_RESULTS_URL` env override).

## Status

**Accepted.** Implemented on `dsh/dev` (config + connector + dispatch +
frontend dropdown + this ADR) and deployed via `./deploy.sh`.

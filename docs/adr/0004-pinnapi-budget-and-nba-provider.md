# pinnapi budget allocation and NBA provider migration

pinnapi's free tier grants ~100 REST requests/day. Today the pipeline spends a
handful of those (one prematch pull per heartbeat, NCAA-only) and leaves the
rest unused. On 2026-11-19 the scope and cadence of that spend were re-decided:
NBA moves onto pinnapi (richer markets, no extra requests — the response already
contained it), the scan cadence rises so the budget is spent deliberately, and
the spend becomes instrumented and guarded. This ADR records the agreed design;
it is the reference the implementation lands against.

## Context

pinnapi is used by exactly one pathway today (ADR-0002): a single
`GET /kit/v1/markets?sport_id=3&event_type=prematch` pull per heartbeat, filtered
client-side to NCAA by `league_name_allowlist`. Facts that bound the design:

- **The same response already contains NBA.** `sport_id=3` is all of basketball
  (ADR-0002: "includes NBA + NCAA + more"). Factoring NBA out of the same pull
  costs **zero** extra requests.
- **NBA today is spread-only from The Odds API.** `run_analysis` prices
  MoneyLine / Spread / Total generically and Danske Spil's NBA feed ships all
  three, so the *only* reason NBA surfaces spread-only opportunities is that its
  Pinnacle provider is spread-only. Moving NBA to pinnapi therefore expands the
  surfaced market scope automatically — a strategy change, not a feed swap.
- **pinnapi's quota is untracked.** No header parsing, no counter, no guard;
  `latest_quota` reads The Odds API headers only.
- **The active-hours window is configurable.** `run_scheduled_scan` gates on
  `business_hours_start` / `business_hours_end` from the `notification_config`
  KV store (defaults `7`/`23`; editable in Settings → Push Notifications →
  Active Scan Hours), enforcing both bounds including overnight windows where
  start > end. The hardware gate is **not** a hardcoded 07–23; the implementation
  must keep reading these keys.
- **Cadence = CLV granularity.** Each fresh pull saves a league-stamped
  `market_snapshots` row; CLV lookups are league-scoped and use the latest
  snapshot before game start.
- **NBA games tip overnight Copenhagen time** (ADR-0003 moved settlement for this
  reason), i.e. *outside* a default 07–23 window. The CLV sniper — a one-shot job
  10 minutes before each real bet, gated by *no* active-hours check — is what
  captures overnight closing lines. It currently pulls from The Odds API.

## Decision

- **Budget, as a function of the configured window.** With cadence `C` minutes
  and active-window length `W` hours, cadence pulls/day `≈ W×60/C`, plus the CLV
  sniper (≈ one pull per real NBA bet/day), plus startup (one per deploy), plus
  sporadic force-scans. At the default `W = 16` (07–23) and `C = 15`, that is
  `≈ 64 + ~8 + startup ≈ 74–77/day`. The implementation MUST compute this from
  the live `business_hours_start`/`business_hours_end` values, not a constant.
- **Cadence 90 → 15 minutes**, uniform within the configured active window, same
  `interval` trigger, active-hours gate unchanged (still read from
  `notification_config`). Raise `CACHE_DURATION` to 900s so a pull is not
  re-triggered by back-to-back scans that land inside the fresh-window.
- **NBA provider → pinnapi.** NBA league config becomes
  `provider: pinnapi`, `sport_id: 3`, `event_type: prematch`,
  `league_name_allowlist: ["NBA"]` (value tuned from the distinct-`league_name`
  logger alongside NCAA), `markets: [money_line, spread, total]`; `notify` and
  `score_source` unchanged. The Odds API is retired from the pull path (see
  Consequences). This is the "seam to migrate NBA later" that ADR-0002 reserved.
- **NBA market scope expands** to MoneyLine + Spread + Total, reusing the
  proven pinnapi→outcomes adapter and full line-curve pricing. Market *scope for
  notifications* is controlled separately by the existing `market_types`
  notification rules (Settings), not by the feed.
- **Quota instrumentation + guard.** Add a persisted daily pinnapi counter in the
  `notification_config` KV store: warn (ntfy) when the day's burn crosses 80,
  and begin serving cached lines (logged) once it crosses 85. Fail-safe above
  the Odds-API-absent 100: never let a live scan hit pinnapi's 403 wall cold.
  At deploy, probe whether pinnapi returns remaining-quota headers; if it does,
  read them instead of the local counter.
- **Failure behavior splits by betting league.** In `fetch_pinnapi_cached`, keyed
  off `league["notify"]`: for real-bet leagues (NBA) a fresh-fetch exception
  **aborts the scan** (returns empty, loudly — no stale pricing for bets); for
  research leagues (NCAA) keep the current stale-cache fallback.
- **CLV sniper → pinnapi.** `perform_clv_snapshot` routes through the bet's
  league provider, so NBA closing lines come from pinnapi (the only path that
  captures overnight closing lines outside the active window).
- **Opportunities endpoint → league provider** so the NBA home view prices from
  the same feed bets are priced from; this fully retires The Odds API from the
  pull path.
- **Snapshot hygiene.** `market_snapshots` grows ≈ 6×; add a periodic prune of
  rows older than ~30 days (their CLV read — latest-before-game-start — has
  resolved).

## Consequences

- NBA opportunities and notifications begin surfacing MoneyLine/Total; the
  existing `market_types` notification rules already scope this and need only be
  tuned in Settings, not code.
- Strategy analysis stays league-scoped (ADR-0002); NBA analysis now includes
  ML/Total paper data — expected, not a regression.
- The budget is a hard ceiling only because the raw API enforces it. At
  `C = 15`, the max sustainable window ≈ `(85 − sniper − startup) / 4 ≈ 19 h`
  before the 85 soft-cap gates pulls. Widening Active Scan Hours beyond that will
  silently degrade to cached lines — the guard, not an error. Documenting this
  ceiling in the Settings UI is optional follow-up.
- `PINNAPI_KEY` (already present in `/opt/appdata/market-scanner/.env`) becomes
  critical to the real-bet league for the first time; an outage now degrades NBA
  to no-scan (by design) rather than to a second source.
- Verification stays production-safe and read-only: `docker compose ps`,
  `GET /api/health`, and backend logs (15-minute heartbeat + pinnapi league
  pulls). Do **not** hit `/api/opportunities` or other side-effecting endpoints
  to verify.

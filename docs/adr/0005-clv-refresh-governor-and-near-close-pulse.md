# Purpose-aware pull governor and near-close CLV pulse

Follow-on to ADR-0004. The pinnapi budget moved from "deliberately spend ~64–77/day"
to "spend up near the ~100/day ceiling" once the CPI provider changed. This ADR
redesigns the CLV-grabbing and refresh system around a single freshness governor,
and adds a near-close closing-line pulse that runs outside the active-hours window
and covers paper bets as well as real bets.

## Context

Today (ADR-0004) there are three pullers behind one blanket 900s in-memory cache:

1. **15-min heartbeat** (`run_scheduled_scan`) — active-hours gated; pulls Danske
   + one shared pinnapi request serving NBA+NCAA. ~64/day at the default window.
2. **CLV sniper** — a one-shot job at T‑10 per *real* placed bet; forces a fresh
   pull overnight. ~1 pull per real bet/day.
3. **Manual refresh** (`/api/opportunities?refresh=true`) and page load
   (`refresh=false`). Refresh is subject to the same 900s cache, so it
   *incidentally* pushes out the next scheduled pull.

Gaps targeted here:
- The heartbeat does not run overnight, so overnight games get no fresh snapshots
  unless a real bet was placed (then only that one T‑10 pull). **Paper bets resolve
  their closing line from the last daytime snapshot — potentially hours stale.**
- Real-bet CLV only refreshes at T‑10 or when the page is viewed; drift in the final
  minutes is not captured.
- The throttle is one blanket 900s that does not distinguish purpose.

Ground truth from the production DB (read-only) at design time: 1 pending real bet;
170 pending paper bets (all NCAA) that are historical season build-up spread over
dates (bulk 105 on one day), i.e. the per-day near-close slate is small and coalesced.
The single shared `sport_id=3` request means one pull captures the closing lines of
every game tipping in the same window.

## Decision

- **One shared pull governor, one shared clock.** Every puller — heartbeat, manual
  refresh, near-close pulse, force-scan — routes through one function that checks a
  single shared "last successful pull" timestamp against a per-purpose freshness.
  Any successful pull resets that one clock. This makes "manual refresh suppresses
  the immediately-next scheduled pull" a guarantee, not a side effect.
- **Per-purpose freshness:** background scan = 15 min (conserve); manual / before-bet
  refresh = 5 min; near-close closing capture = 5 min. All share the one clock.
- **Near-close CLV pulse (event-driven, not polling).** Replaces and generalizes the
  T‑10 sniper. A one-shot job is scheduled per tracked game (pending real bet *and*
  active paper bet) at T‑X before tip, running with **no active-hours gate**. The
  shared governor coalesces back-to-back/degenerate jobs into one pull rebased to
  the 5-min freshness. League-scoped (NBA/NCAA never interleave), reusing the
  existing snapshot save + `closing_odds` write paths.
- **X (window) = 30 min (`T‑30`)**, one best-effort near-close point per game,
  upgraded opportunistically when a later governor tick lands inside the window
  anyway.
- **Purpose-aware soft-cap.** Near-close CLV pulls stay protected past the soft-cap
  up to the hard ceiling; background scanning throttles first. Soft-cap raised
  **85 → 95** (real ceiling ~100); warning lowered to ~85. A **T‑10 deadline
  grace** lets a near-close pull cross the hard ceiling (failsafe for a true
  closing line, risking at most one 403).
- **Persist the pull clock and per-purpose counters** in the `notification_config`
  KV store so a restart within a fresh window is pull-neutral (quota counter is
  already persisted there).
- **Retire the old T‑10 sniper**; the generalized near-close scanner covers real
  bets. A failed near-close job degrades to "last snapshot," logged.
- **UI surfacing:** keep the single `pinnacle_age`, add soft-cap count and next-scan
  ETA so conservation is visible when refreshing before a bet.

## Consequences

- Paper-bet closing lines for overnight games become near-close instead of
  daytime-stale — the main CLV/EV quality win.
- Real-bet and paper CLV capture are unified behind one pulse; the per-real-bet
  sniper and its code path are removed.
- Budget moves toward ~100/day ceiling by design; the near-close pulse is protected
  above background scanning at the cap.
- `market_snapshots` grows somewhat near close; the existing 30-day prune (ADR-0004)
  is unchanged.
- Verification remains production-safe and read-only; do not hit side-effecting
  endpoints to confirm.

## Decisions confirmed in grilling (R2/R3)

- Manual refresh uses 5-min purpose freshness (`PURPOSE_MANUAL`); near-close uses
  the same 5-min (`PURPOSE_NEAR_CLOSE`); background stays 15-min.
- The pull clock persists under `clv_last_pull_ts` + `clv_last_pull_date`.
- Sniper removed; near-close pulse replaces it (real bets covered).
- One commit implementing governor + near-close pulse + ADR, deployed per the
  repo's `dsh/dev` → `./deploy.sh` pipeline.

## Status

**Accepted.** Implemented on `dsh/dev`; ADR-0004 constants retuned (warn 85,
soft-cap 95).
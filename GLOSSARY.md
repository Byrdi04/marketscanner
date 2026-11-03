# Market Scanner

Single-user betting-scanner monorepo. Production is the only environment: it is deployed from the repo root via `./deploy.sh` and verified through the npmplus proxy, never through a separate environment.

## Language

**Deploy**:
Build the production images and restart the production stack by running `./deploy.sh` from the repo root. This is the release step — there is no staging between a push and production.
_Avoid_: Release, ship

**Push**:
Upload local commits to `origin/dsh/dev`. A push without a later deploy leaves production behind the repo.
_Avoid_: Deploy — pushing is only the upload half of the pipeline

**Production stack**:
The two containers `market-scanner-backend` and `market-scanner-frontend` defined by `docker-compose.yml`, fronted by the npmplus reverse proxy on `proxy-net`.
_Avoid_: App, service

**Prod surface**:
The read-only verification surface of the production stack: `http://odds.lan` (LAN) and `https://odds.partitest.dk` (public), allowing reachability checks plus `GET /api/health`. It is production, not a test environment.
_Avoid_: Staging, test env

**Scan league**:
A competition the heartbeat scans as its own configured unit — currently NBA and NCAA — each with its own Danske Spil tag, Pinnacle provider + sport, market scope, and score source. Paper bets are tagged with their scan league.
_Avoid_: Sport, "league" alone (ambiguous with a betting-market league)

**Pinnacle provider**:
The configured sharp-odds feed a scan league draws Pinnacle prices from: The Odds API (legacy, NBA) or pinnapi (NCAA). A per-league provider selector is the seam to migrate NBA off the legacy feed later.
_Avoid_: Pinnacle API, the odds feed

**NCAA scan**:
The data-gathering pass that logs `league='NCAA'` paper bets only. It deliberately touches no real bets, no portfolio, and no analytics until a strategy is developed from the collected data.
_Avoid_: Adding NCAA, the NCAA feature

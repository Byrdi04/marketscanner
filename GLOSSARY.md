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

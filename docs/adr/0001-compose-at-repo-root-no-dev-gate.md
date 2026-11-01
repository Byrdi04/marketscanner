# Production runs from docker compose at the repo root; every dsh/dev push deploys

Single-user project: on 2026-11-01 the production stack moved out of Portainer into `docker-compose.yml` at the repo root, the separate dev container was dropped, and the workflow became commit → push to `dsh/dev` → `./deploy.sh` (rebuild + restart + smoke test). There is no dev or staging environment and no review gate: every pushed change goes live.

Portainer was rejected because its stacks lived outside the repo and could not be versioned with the code; a repo-root compose keeps the stack definition and the deploy procedure (`deploy.sh`) under version control with the app. The dev container was rejected because its job — isolated previews of pushes — gated a pipeline with exactly one consumer. This is only safe because the single user accepts immediate deploys and because real production data lives outside the repo at `/opt/appdata/market-scanner/` (mounted at `/app/data`, env via `/opt/appdata/market-scanner/.env`).

Consequences: the agent runs the deploy step itself, so verification against production is restricted to the read-only prod surface (`GET /api/health` plus frontend reachability); there is no safe staging target for write/action behaviour, so throwaway scratch containers are the fallback for probing side-effecting endpoints.

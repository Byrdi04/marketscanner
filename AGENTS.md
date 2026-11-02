# Market Scanner — Agent Instructions

## Operating model
Personal, single-user project. **There is no dev or staging environment.** The production stack is defined by `docker-compose.yml` at the repo root and deployed from this host. A push to `dsh/dev` followed by a deploy *is* the release pipeline.

## Workflow: change → production
1. Work on `dsh/dev`. Never commit to `main`.
2. Commit after each logical change with a conventional prefix (`feat:`, `fix:`, `chore:`, `refactor:`). Run `git status` first.
3. Push: `git push origin dsh/dev`.
4. Deploy from the repo root: `./deploy.sh`. It rebuilds both images, restarts the stack, and smoke-checks frontend + backend.
5. Confirm the push landed and the stack is up: `git log --oneline origin/dsh/dev -n 3` and `docker compose ps`.

When finished, tell the user:
"Changes deployed to production. Review at http://odds.lan (LAN) or https://odds.partitest.dk (public)."

## Production stack
- `docker-compose.yml` at the repo root is the single source of truth; `deploy.sh` is the deploy procedure. Do not restate either in this file.
- Backend container `market-scanner-backend` (FastAPI, port 8000); frontend container `market-scanner-frontend` (Next.js, port 3000).
- Served through the npmplus reverse proxy on the shared `proxy-net` network. Persistent data lives **outside the repo** at `/opt/appdata/market-scanner/` (production SQLite `bets.db` + `.env`, mounted at container `/app/data`).
- Dependency changes (`backend/requirements.txt`, `frontend/package.json`) take effect on the next `./deploy.sh` rebuild.
- Both containers run `TZ=Europe/Copenhagen`. Wall-clock logic in `backend/main.py` (the heartbeat scan gate and the 05:00 settlement cron) assumes local time; do not reinterpret these as UTC.
- The automatic-scan window is not hardcoded: it reads `business_hours_start` / `business_hours_end` (default `7`/`23`, DB key-value store `notification_config`) and enforces both bounds, including overnight windows (start > end). Editable in Settings → Push Notifications → Active Scan Hours.

## Prod surface (the only allowed target of verification)
Against production, only these are side-effect-free: `http://odds.lan/` (frontend reachable) and `GET http://odds.lan/api/health` (backend liveness). An agent may call those, and nothing else on production, unless the user signs off on the specific call first. In particular: action endpoints (`place-bet`, `settle-bets`, `force-scan`, `test-notification`, settings/bankroll writes) and even side-effecting GETs like `/api/opportunities` — they scrape Pinnacle/Danske Spil and update CLV in the production DB.
To probe anything side-effecting, use a throwaway scratch container that touches neither production data nor the production network.

## Never
- Never commit database files (`backend/data/`, any `*.db`), `.env` files, or secrets.
- Never point a scratch container at production data or networks.

## Layout
- Repo root: `/opt/docker-stacks/market-scanner`
- Backend: `backend/` — FastAPI, entry `backend/main.py`, deps `backend/requirements.txt`
- Frontend: `frontend/` — Next.js App Router, deps `frontend/package.json`
- Deploy: `./deploy.sh` · Stack: `docker-compose.yml` · Decisions: `docs/adr/` · Terms: `GLOSSARY.md`

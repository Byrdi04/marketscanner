# DSH Agent Instructions

## Git Workflow

### Branching
- Always work on the `dsh/dev` branch unless told otherwise
- Never commit directly to `main`
- Check you are on the right branch before starting: `git checkout dsh/dev`
- Use conventional commit message prefixes: `feat:`, `fix:`, `chore:`, `refactor:`

### Committing
- Commit after each logical change, not only at the end of the session
- Always run `git status` before committing to confirm what you are staging
- Never commit the `backend/data/` directory
- Never commit `.env` files or secrets of any kind

### Pushing
- Push to GitHub after every commit: `git push origin dsh/dev`
- If the branch does not exist on remote yet: `git push -u origin dsh/dev`

### When finished
- Confirm the final push succeeded: `git log --oneline origin/dsh/dev -n 3`
- Tell the user: "Changes pushed to GitHub on branch `dsh/dev`.
  The dev container will pick them up within 30 seconds.
  Check http://market-scanner-dev.local to review."

## Dev Container
- Polls GitHub every 30 seconds for changes on the `dsh/dev` branch
- Automatically reinstalls Python dependencies if `backend/requirements.txt` changes
- Automatically reinstalls Node dependencies if `frontend/package.json` changes
- Restarts both backend and frontend after every successful pull

## Project Structure
- Monorepo with `backend/` and `frontend/` directories
- Backend: FastAPI (Python 3.11), runs on port 8000
- Frontend: Next.js, runs on port 3000
- The frontend reaches the backend via `BACKEND_URL=http://localhost:8000`

## Backend Details
- Framework: FastAPI
- Entry point: `backend/main.py`
- Dependencies: `backend/requirements.txt`
- Database: SQLite at `backend/data/bets.db` — never modify via git
- Dev command: `uvicorn main:app --reload --host 0.0.0.0 --port 8000`

## Frontend Details
- Framework: Next.js
- Dependencies: `frontend/package.json`
- Dev command: `npm run dev`
- Port: 3000

## Important Paths
- Workspace root: `/workspace/market-scanner`
- Backend code: `/workspace/market-scanner/backend/`
- Frontend code: `/workspace/market-scanner/frontend/`
- Data directory: `backend/data/` — mounted volume, never tracked by git

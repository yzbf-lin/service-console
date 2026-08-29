# pd-qa-backend native development profile

This profile deliberately starts native host commands. It does not invoke Docker, Compose, or a
container runtime.

1. Start the packaged desktop application (recommended):

   ```bash
   open "dist/Service Console.app"
   ```

   A packaged macOS app opened from Finder restores the exported interactive login-shell environment
   once at startup, so commands such as `uv run backend/run.py` do not require an absolute `uv` path.
   A service-level `env.PATH` remains the final override for project-specific toolchains.

   The CLI automatically discovers the desktop controller's random loopback endpoint. For isolated
   acceptance tests, `uv run service-console serve --data-dir /tmp/service-console-pd-qa` remains an
   alternative, but it must not use the desktop application's data directory.

2. From another terminal, register the sibling checkout:

   ```bash
   ./scripts/register-pd-qa-backend.sh
   ```

   With the Codex MCP integration installed, keep the equivalent definitions in the project-root
   `.service-console.json` and ask the agent to call:

   ```text
   project_apply_config(config_path="/absolute/path/to/pd-qa-backend/.service-console.json")
   ```

   The manifest is then the source of truth; repeated calls update changed definitions and skip
   unchanged ones without deleting unrelated services.

3. Start each service from the browser, TUI, or CLI:

   ```bash
   uv run service-console start pd-qa-backend
   uv run service-console start pd-qa-frontend
   uv run service-console start pd-qa-celery-worker

   # Start only when periodic scheduling is required.
   uv run service-console start pd-qa-celery-beat
   ```

4. Acceptance checks:

   - Backend remains `RUNNING` and listens on port `8000`.
   - Frontend remains `RUNNING` and listens on port `5173`.
   - Celery worker remains `RUNNING` and emits worker startup/broker logs.
   - Celery beat, when explicitly started, remains `RUNNING` and emits scheduler logs.
   - Each service has an independent log view.
   - Restart changes the PID and increments `restart_count`.
   - Stop reaches `STOPPED` and releases the corresponding process group or Windows process tree.

5. For day-to-day work from the sibling `pd-qa-backend` checkout, use its stable project wrapper:

   ```bash
   ./scripts/dev-services.sh status
   ./scripts/dev-services.sh restart backend worker
   ./scripts/dev-services.sh logs backend --tail 200
   ```

   Its `all` alias means backend, worker, and frontend. It deliberately excludes beat to prevent
   accidental duplicate scheduling.

The backend and worker load the existing `backend/.env`. Their database and broker endpoints must be
reachable for a complete application-level startup. Service Console still records connection failures
and exit states when those external dependencies are unavailable.

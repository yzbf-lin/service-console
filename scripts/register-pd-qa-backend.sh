#!/usr/bin/env bash
set -euo pipefail

SERVICE_CONSOLE_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PD_QA_BACKEND_ROOT="${PD_QA_BACKEND_ROOT:-$(cd "${SERVICE_CONSOLE_ROOT}/../pd-qa-backend" && pwd)}"
DEFAULT_PD_QA_LOG_FORMAT='<green>{time:YYYY-MM-DD HH:mm:ss.SSS}</> | <lvl>{level: <8}</> | <cyan>{request_id}</> | <lvl>{message}</>'
PD_QA_LOG_FORMAT="${PD_QA_LOG_FORMAT:-$DEFAULT_PD_QA_LOG_FORMAT}"

client=(uv run --project "${SERVICE_CONSOLE_ROOT}" service-console)
if [[ -n "${SERVICE_CONSOLE_URL:-}" ]]; then
  client+=(--url "${SERVICE_CONSOLE_URL}")
fi
if [[ -n "${SERVICE_CONSOLE_TOKEN:-}" ]]; then
  client+=(--token "${SERVICE_CONSOLE_TOKEN}")
fi

echo "Registering native services from ${PD_QA_BACKEND_ROOT}"

"${client[@]}" add pd-qa-backend \
  --command "uv run backend/run.py" \
  --cwd "${PD_QA_BACKEND_ROOT}" \
  --env PYTHONUNBUFFERED=1 \
  --env "LOG_FORMAT=${PD_QA_LOG_FORMAT}" \
  --stop-timeout 10

"${client[@]}" add pd-qa-frontend \
  --command "pnpm dev:antdv-next" \
  --cwd "${PD_QA_BACKEND_ROOT}/frontend" \
  --stop-timeout 10

"${client[@]}" add pd-qa-celery-worker \
  --command "uv run fba celery worker --hostname service-console@%h --concurrency 1" \
  --cwd "${PD_QA_BACKEND_ROOT}" \
  --env PYTHONUNBUFFERED=1 \
  --stop-timeout 15

"${client[@]}" add pd-qa-celery-beat \
  --command "uv run fba celery beat" \
  --cwd "${PD_QA_BACKEND_ROOT}" \
  --env PYTHONUNBUFFERED=1 \
  --stop-timeout 15

echo "Registered backend, frontend, Celery worker, and Celery beat."
echo "Open Service Console or run: uv run --project ${SERVICE_CONSOLE_ROOT} service-console tui"

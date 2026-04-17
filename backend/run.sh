#!/usr/bin/env bash
set -euo pipefail

# Always run from the backend directory so relative imports resolve consistently.
cd "$(dirname "$0")"
# Start FastAPI with auto-reload for local development.
uvicorn app.main:app --reload --host 0.0.0.0 --port 8000

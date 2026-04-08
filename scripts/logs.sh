#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# Default to following logs if no flags are passed
if [ $# -eq 0 ]; then
  exec docker compose logs -f --tail 100
else
  exec docker compose logs "$@"
fi

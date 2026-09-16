#!/usr/bin/env bash
# Re-key occurrence-keyed meeting documents onto per-session keys and recover
# sessions that the old one-document-per-day key discarded.
# Dry run by default; pass --apply to write.
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

if [ "$(docker inspect --format '{{.State.Running}}' meetings-mcp 2>/dev/null)" != "true" ]; then
  echo "meetings-mcp container is not running — start it with scripts/start.sh" >&2
  exit 1
fi

docker exec meetings-mcp node src/cli/migrate-session-ids.js "$@"

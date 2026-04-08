#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# launchd provides a minimal PATH — ensure Homebrew and standard bins are available
export PATH="/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:$PATH"

# Wait for Docker daemon to be ready (up to 2 minutes after login)
for i in $(seq 1 60); do
  if docker info > /dev/null 2>&1; then
    break
  fi
  if [ "$i" -eq 60 ]; then
    echo "Docker daemon not available after 120s — giving up" >&2
    exit 1
  fi
  sleep 2
done

# Start containers in detached mode (no --build; image should already exist)
docker compose up -d

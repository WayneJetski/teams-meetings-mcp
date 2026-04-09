#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

info() { echo -e "${GREEN}[update]${NC} $*"; }
warn() { echo -e "${YELLOW}[update]${NC} $*"; }

info "Pulling latest changes..."
PULL_OUTPUT=$(git pull 2>&1) || {
  warn "Could not pull — you may have local changes. Continuing with current version."
  PULL_OUTPUT=""
}

if echo "$PULL_OUTPUT" | grep -q "Already up to date"; then
  info "Already up to date — skipping rebuild."
else
  info "Changes detected. Rebuilding and restarting containers..."
  docker compose up -d --build
fi

info "Update complete. Run 'teams-mcp logs' to check status."

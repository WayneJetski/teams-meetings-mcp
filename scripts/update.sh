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
git pull || {
  warn "Could not pull — you may have local changes. Continuing with current version."
}

info "Rebuilding and restarting containers..."
docker compose up -d --build

info "Update complete. Run 'teams-mcp logs' to check status."

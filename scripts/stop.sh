#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'
NC='\033[0m'

info() { echo -e "${GREEN}[stop]${NC} $*"; }

info "Stopping containers..."
docker compose down "$@"
info "Containers stopped."

#!/usr/bin/env bash
set -euo pipefail

LABEL="com.teams-meetings-mcp"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"

GREEN='\033[0;32m'
NC='\033[0m'
info() { echo -e "${GREEN}[service]${NC} $*"; }

if launchctl print "gui/$(id -u)/$LABEL" > /dev/null 2>&1; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  info "Service unloaded."
else
  info "Service was not loaded."
fi

if [ -f "$PLIST_PATH" ]; then
  rm "$PLIST_PATH"
  info "Plist removed: $PLIST_PATH"
else
  info "No plist found at $PLIST_PATH"
fi

info "Service uninstalled. Containers are still running — use 'docker compose down' to stop them."

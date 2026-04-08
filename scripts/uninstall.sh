#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"

# ── Colors ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[uninstall]${NC} $*"; }
warn()  { echo -e "${YELLOW}[uninstall]${NC} $*"; }
error() { echo -e "${RED}[uninstall]${NC} $*"; }

LINK_TARGET="/usr/local/bin/teams-mcp"
MCP_CONFIG="$HOME/.claude.json"
MCP_SERVER_NAME="teams-insights"

echo -e "${BOLD}Teams Meeting Insights MCP — Uninstall${NC}"
echo ""
echo "This will:"
echo "  1. Stop and remove Docker containers and volumes"
echo "  2. Remove the background service (launchd agent)"
echo "  3. Remove the teams-mcp symlink from $LINK_TARGET"
echo "  4. Remove the MCP server entry from Claude config"
echo ""

read -rp "Continue? [y/N] " CONFIRM < /dev/tty
if [[ ! "$CONFIRM" =~ ^[Yy]$ ]]; then
  info "Aborted."
  exit 0
fi

# ── Stop containers ──────────────────────────────────────────────────
if [ -f "$REPO_DIR/docker-compose.yml" ] || [ -f "$REPO_DIR/compose.yml" ]; then
  info "Stopping and removing containers..."
  cd "$REPO_DIR"
  docker compose down -v 2>/dev/null || warn "Could not stop containers (may already be stopped)."
else
  warn "No compose file found — skipping container cleanup."
fi

# ── Remove background service (launchd) ─────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
  LABEL="com.teams-meetings-mcp"
  PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
  if launchctl print "gui/$(id -u)/$LABEL" > /dev/null 2>&1; then
    info "Removing background service..."
    launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  fi
  if [ -f "$PLIST_PATH" ]; then
    rm -f "$PLIST_PATH"
    info "Launchd agent removed."
  else
    info "No launchd agent found — skipping."
  fi
fi

# ── Remove symlink ───────────────────────────────────────────────────
if [ -L "$LINK_TARGET" ] || [ -f "$LINK_TARGET" ]; then
  info "Removing $LINK_TARGET..."
  if [ -w "$(dirname "$LINK_TARGET")" ]; then
    rm -f "$LINK_TARGET"
  else
    sudo rm -f "$LINK_TARGET"
  fi
  info "Symlink removed."
else
  info "No symlink found at $LINK_TARGET — skipping."
fi

# ── Remove MCP config entry ─────────────────────────────────────────
if [ -f "$MCP_CONFIG" ]; then
  if node -e "
    const cfg = JSON.parse(require('fs').readFileSync('$MCP_CONFIG', 'utf8'));
    process.exit((cfg.mcpServers || {})['$MCP_SERVER_NAME'] ? 0 : 1);
  " 2>/dev/null; then
    info "Removing '$MCP_SERVER_NAME' from Claude MCP config..."
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$MCP_CONFIG', 'utf8'));
      delete (cfg.mcpServers || {})['$MCP_SERVER_NAME'];
      fs.writeFileSync('$MCP_CONFIG', JSON.stringify(cfg, null, 2) + '\n');
    "
    info "MCP config entry removed."
  else
    info "No '$MCP_SERVER_NAME' entry in Claude config — skipping."
  fi
fi

# ── Optionally remove the repo ───────────────────────────────────────
echo ""
read -rp "Also delete the repo at $REPO_DIR? [y/N] " DELETE_REPO < /dev/tty
if [[ "$DELETE_REPO" =~ ^[Yy]$ ]]; then
  info "Removing $REPO_DIR..."
  rm -rf "$REPO_DIR"
  info "Repo deleted."
else
  info "Keeping repo at $REPO_DIR."
fi

echo ""
info "Uninstall complete."

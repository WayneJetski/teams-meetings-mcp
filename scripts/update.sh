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

# ── Migrate Claude Code MCP config to native HTTP transport ──────────
# Older versions wrote `command: npx -y mcp-remote ...` which adds ~16s to
# every Claude Code session start. Native HTTP transport avoids that.
MCP_CONFIG="$HOME/.claude.json"
MCP_SERVER_NAME="teams-insights"
MCP_URL="http://localhost:4005/mcp"

if [ -f "$MCP_CONFIG" ] && command -v node >/dev/null 2>&1; then
  MIGRATION_RESULT=$(node -e "
    const fs = require('fs');
    const path = '$MCP_CONFIG';
    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); } catch { process.exit(0); }
    const servers = cfg.mcpServers || {};
    const existing = servers['$MCP_SERVER_NAME'];
    if (!existing) { console.log('absent'); process.exit(0); }
    const desired = { type: 'http', url: '$MCP_URL' };
    const isCurrent =
      existing.type === desired.type &&
      existing.url === desired.url &&
      !existing.command &&
      !existing.args;
    if (isCurrent) { console.log('current'); process.exit(0); }
    servers['$MCP_SERVER_NAME'] = desired;
    cfg.mcpServers = servers;
    fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    console.log('migrated');
  " 2>/dev/null || echo "skipped")

  case "$MIGRATION_RESULT" in
    migrated) info "Migrated Claude Code MCP config to native HTTP transport (faster session start). Restart Claude Code to pick up the change.";;
    current|absent|skipped) ;;
  esac
fi

info "Update complete. Run 'teams-mcp logs' to check status."

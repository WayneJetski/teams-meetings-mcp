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
#
# Walks every `mcpServers` block in ~/.claude.json (top-level AND every
# `projects.<path>.mcpServers`) so project-scoped entries get migrated too.
MCP_CONFIG="$HOME/.claude.json"
MCP_SERVER_NAME="teams-insights"
MCP_URL="http://localhost:4005/mcp"

if ! command -v node >/dev/null 2>&1; then
  warn "node not found on PATH — skipping Claude Code MCP config migration."
elif [ ! -f "$MCP_CONFIG" ]; then
  info "No Claude Code config at $MCP_CONFIG — nothing to migrate."
else
  MIGRATION_OUTPUT=$(node -e "
    const fs = require('fs');
    const path = '$MCP_CONFIG';
    const name = '$MCP_SERVER_NAME';
    const desired = { type: 'http', url: '$MCP_URL' };

    let cfg;
    try { cfg = JSON.parse(fs.readFileSync(path, 'utf8')); }
    catch (e) { console.log('PARSE_ERROR ' + e.message); process.exit(0); }

    const blocks = [];
    if (cfg.mcpServers && typeof cfg.mcpServers === 'object') {
      blocks.push({ label: '(global)', container: cfg.mcpServers });
    }
    if (cfg.projects && typeof cfg.projects === 'object') {
      for (const projectPath of Object.keys(cfg.projects)) {
        const proj = cfg.projects[projectPath];
        if (proj && typeof proj === 'object' && proj.mcpServers && typeof proj.mcpServers === 'object') {
          blocks.push({ label: projectPath, container: proj.mcpServers });
        }
      }
    }

    let migrated = 0;
    let alreadyCurrent = 0;
    let totalFound = 0;
    for (const { label, container } of blocks) {
      const existing = container[name];
      if (!existing) continue;
      totalFound++;
      const isCurrent =
        existing.type === desired.type &&
        existing.url === desired.url &&
        !existing.command &&
        !existing.args;
      if (isCurrent) {
        alreadyCurrent++;
        console.log('CURRENT ' + label);
      } else {
        container[name] = { ...desired };
        migrated++;
        console.log('MIGRATED ' + label);
      }
    }

    if (migrated > 0) {
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    }
    if (totalFound === 0) {
      console.log('ABSENT');
    }
  " 2>&1) || {
    warn "MCP config migration failed: $MIGRATION_OUTPUT"
    MIGRATION_OUTPUT=""
  }

  MIGRATED_COUNT=0
  CURRENT_COUNT=0
  while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    case "$LINE" in
      "MIGRATED "*)
        MIGRATED_COUNT=$((MIGRATED_COUNT + 1))
        info "Migrated MCP entry in scope ${LINE#MIGRATED }"
        ;;
      "CURRENT "*)
        CURRENT_COUNT=$((CURRENT_COUNT + 1))
        ;;
      "ABSENT")
        info "No '$MCP_SERVER_NAME' entry found in $MCP_CONFIG — nothing to migrate."
        ;;
      "PARSE_ERROR "*)
        warn "Could not parse $MCP_CONFIG: ${LINE#PARSE_ERROR }"
        ;;
    esac
  done <<< "$MIGRATION_OUTPUT"

  if [ "$MIGRATED_COUNT" -gt 0 ]; then
    info "Migrated $MIGRATED_COUNT MCP entry/entries to native HTTP transport. Restart Claude Code to pick up the change."
  elif [ "$CURRENT_COUNT" -gt 0 ]; then
    info "MCP config already on native HTTP transport ($CURRENT_COUNT entry/entries) — no migration needed."
  fi
fi

info "Update complete. Run 'teams-mcp logs' to check status."

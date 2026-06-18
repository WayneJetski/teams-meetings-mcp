#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

# ── Colors ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[start]${NC} $*"; }
warn()  { echo -e "${YELLOW}[start]${NC} $*"; }
error() { echo -e "${RED}[start]${NC} $*"; }

# ── Banner ───────────────────────────────────────────────────────────
echo -e "${CYAN}${BOLD}"
cat << 'BANNER'

  ████████╗███████╗ █████╗ ███╗   ███╗███████╗
  ╚══██╔══╝██╔════╝██╔══██╗████╗ ████║██╔════╝
     ██║   █████╗  ███████║██╔████╔██║███████╗
     ██║   ██╔══╝  ██╔══██║██║╚██╔╝██║╚════██║
     ██║   ███████╗██║  ██║██║ ╚═╝ ██║███████║
     ╚═╝   ╚══════╝╚═╝  ╚═╝╚═╝     ╚═╝╚══════╝
  ███╗   ███╗ ██████╗██████╗
  ████╗ ████║██╔════╝██╔══██╗
  ██╔████╔██║██║     ██████╔╝
  ██║╚██╔╝██║██║     ██╔═══╝
  ██║ ╚═╝ ██║╚██████╗██║
  ╚═╝     ╚═╝ ╚═════╝╚═╝
BANNER
echo -e "${NC}"
echo -e "  ${CYAN}Meeting Insights for Claude Code${NC}"
echo ""

# ── Check .env ────────────────────────────────────────────────────────
if [ ! -f .env ]; then
  warn ".env file not found — creating from .env.example"
  cp .env.example .env

  # Generate a random SESSION_SECRET automatically
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  if grep -q '^SESSION_SECRET=' .env; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/^SESSION_SECRET=.*/SESSION_SECRET=${SESSION_SECRET}/" .env
    else
      sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=${SESSION_SECRET}/" .env
    fi
  else
    echo "SESSION_SECRET=${SESSION_SECRET}" >> .env
  fi

  error "Please edit .env and fill in your Azure credentials, then re-run this script."
  error "  Required: AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_CLIENT_SECRET"
  error ""
  error "  See README.md for Azure app registration setup."
  exit 1
fi

# Validate required vars are set (not just placeholder values).
# Parse .env line-by-line instead of `source`-ing it — values like
# `SYNC_CRON=*/15 * * * *` would otherwise glob-expand and silently abort the script.
while IFS= read -r line || [ -n "$line" ]; do
  line="${line%$'\r'}"
  [[ -z "$line" || "$line" =~ ^[[:space:]]*# ]] && continue
  [[ "$line" != *=* ]] && continue
  key="${line%%=*}"
  value="${line#*=}"
  # Strip surrounding single or double quotes if present
  if [[ "$value" =~ ^\".*\"$ ]] || [[ "$value" =~ ^\'.*\'$ ]]; then
    value="${value:1:${#value}-2}"
  fi
  printf -v "$key" '%s' "$value"
done < .env

# Auto-generate SESSION_SECRET if missing or still the placeholder
SESSION_SECRET="${SESSION_SECRET:-}"
if [ -z "$SESSION_SECRET" ] || [ "$SESSION_SECRET" = "change-me-to-a-random-string" ]; then
  info "Generating random SESSION_SECRET..."
  SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  if grep -q '^SESSION_SECRET=' .env; then
    if [[ "$OSTYPE" == "darwin"* ]]; then
      sed -i '' "s/^SESSION_SECRET=.*/SESSION_SECRET=${SESSION_SECRET}/" .env
    else
      sed -i "s/^SESSION_SECRET=.*/SESSION_SECRET=${SESSION_SECRET}/" .env
    fi
  else
    echo "SESSION_SECRET=${SESSION_SECRET}" >> .env
  fi
fi

for var in AZURE_TENANT_ID AZURE_CLIENT_ID AZURE_CLIENT_SECRET; do
  val="${!var:-}"
  if [ -z "$val" ] || [ "$val" = "your-tenant-id" ] || [ "$val" = "your-client-id" ] || [ "$val" = "your-client-secret" ]; then
    error "Required variable $var is not configured in .env"
    exit 1
  fi
done

# ── Docker ────────────────────────────────────────────────────────────
info "Starting Docker containers..."
docker compose up -d --build

info "Waiting for server to become healthy..."
for i in $(seq 1 30); do
  if curl -sf http://localhost:4005/health > /dev/null 2>&1; then
    info "Server is healthy!"
    break
  fi
  if [ "$i" -eq 30 ]; then
    error "Server did not become healthy in time. Check: docker compose logs mcp-server"
    exit 1
  fi
  sleep 2
done

# ── Configure MCP in Claude Code ─────────────────────────────────────
MCP_CONFIG="$HOME/.claude.json"
MCP_SERVER_NAME="teams-insights"
MCP_URL="http://localhost:4005/mcp"

configure_mcp() {
  if [ ! -f "$MCP_CONFIG" ]; then
    info "Creating Claude MCP config at $MCP_CONFIG"
    cat > "$MCP_CONFIG" << 'MCPEOF'
{
  "mcpServers": {}
}
MCPEOF
  fi

  # Desired config: native HTTP transport (avoids ~16s cold start from `npx mcp-remote`).
  # Ensures the global entry is correct AND migrates any project-scoped entries
  # (under projects.<path>.mcpServers) that older versions may have written.
  CONFIGURE_OUTPUT=$(node -e "
    const fs = require('fs');
    const path = '$MCP_CONFIG';
    const name = '$MCP_SERVER_NAME';
    const desired = { type: 'http', url: '$MCP_URL' };
    const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));

    if (!cfg.mcpServers) cfg.mcpServers = {};

    let changed = false;
    let action = 'current';

    const globalExisting = cfg.mcpServers[name];
    const globalIsCurrent =
      globalExisting &&
      globalExisting.type === desired.type &&
      globalExisting.url === desired.url &&
      !globalExisting.command &&
      !globalExisting.args;
    if (!globalIsCurrent) {
      cfg.mcpServers[name] = { ...desired };
      changed = true;
      action = globalExisting ? 'migrated' : 'added';
    }
    console.log(action + ' (global)');

    if (cfg.projects && typeof cfg.projects === 'object') {
      for (const projectPath of Object.keys(cfg.projects)) {
        const proj = cfg.projects[projectPath];
        if (!proj || typeof proj !== 'object') continue;
        if (!proj.mcpServers || typeof proj.mcpServers !== 'object') continue;
        const existing = proj.mcpServers[name];
        if (!existing) continue;
        const isCurrent =
          existing.type === desired.type &&
          existing.url === desired.url &&
          !existing.command &&
          !existing.args;
        if (!isCurrent) {
          proj.mcpServers[name] = { ...desired };
          changed = true;
          console.log('migrated ' + projectPath);
        }
      }
    }

    if (changed) {
      fs.writeFileSync(path, JSON.stringify(cfg, null, 2) + '\n');
    }
  " 2>&1) || warn "MCP config update failed: $CONFIGURE_OUTPUT"

  while IFS= read -r LINE; do
    [ -z "$LINE" ] && continue
    case "$LINE" in
      "current (global)")  info "MCP server '$MCP_SERVER_NAME' already configured (HTTP transport).";;
      "added (global)")    info "Added MCP server '$MCP_SERVER_NAME' (HTTP transport). Restart Claude Code to pick up the change.";;
      "migrated (global)") info "Migrated MCP server '$MCP_SERVER_NAME' to native HTTP transport. Restart Claude Code to pick up the change.";;
      "migrated "*)        info "Migrated MCP server '$MCP_SERVER_NAME' under project ${LINE#migrated } to native HTTP transport.";;
    esac
  done <<< "$CONFIGURE_OUTPUT"
}

configure_mcp

# ── Configure MCP in Claude Desktop (macOS) ──────────────────────────
configure_claude_desktop() {
  [[ "$OSTYPE" != "darwin"* ]] && return 0

  local desktop_dir="$HOME/Library/Application Support/Claude"
  local desktop_config="$desktop_dir/claude_desktop_config.json"

  # If the parent dir doesn't exist, Claude Desktop hasn't been installed/run — skip silently.
  if [ ! -d "$desktop_dir" ]; then
    return 0
  fi

  if [ ! -f "$desktop_config" ]; then
    info "Creating Claude Desktop MCP config at $desktop_config"
    echo '{"mcpServers":{}}' > "$desktop_config"
  fi

  # Claude Desktop only reliably supports stdio servers (command + args). The
  # native `{ type: http, url }` shape used for Claude Code silently fails to
  # load here, so we wrap the endpoint in `npx mcp-remote`. The transform also
  # migrates any older broken `type: http` entry back to the stdio form.
  local desktop_output
  desktop_output=$(DESKTOP_CONFIG_PATH="$desktop_config" MCP_NAME="$MCP_SERVER_NAME" MCP_URL_VAL="$MCP_URL" NPMRC_PATH="$REPO_DIR/.npmrc" node -e "
    const fs = require('fs');
    const { applyDesktopMcpConfig } = require('$REPO_DIR/scripts/lib/desktop-mcp-config.cjs');
    const path = process.env.DESKTOP_CONFIG_PATH;
    const cfg = JSON.parse(fs.readFileSync(path, 'utf8'));
    const { config, action } = applyDesktopMcpConfig(cfg, process.env.MCP_NAME, process.env.MCP_URL_VAL, process.env.NPMRC_PATH);
    if (action !== 'current') {
      fs.writeFileSync(path, JSON.stringify(config, null, 2) + '\n');
    }
    console.log(action);
  " 2>&1) || { warn "Claude Desktop MCP config update failed: $desktop_output"; return 0; }

  case "$desktop_output" in
    "current")  info "Claude Desktop: MCP server '$MCP_SERVER_NAME' already configured (mcp-remote stdio).";;
    "added")    info "Claude Desktop: Added MCP server '$MCP_SERVER_NAME' (mcp-remote stdio). Restart Claude Desktop to pick up the change.";;
    "migrated") info "Claude Desktop: Migrated MCP server '$MCP_SERVER_NAME' to mcp-remote stdio transport. Restart Claude Desktop to pick up the change.";;
  esac
}

configure_claude_desktop

# ── Background service (macOS launchd) ───────────────────────────────
if [[ "$OSTYPE" == "darwin"* ]]; then
  LABEL="com.teams-meetings-mcp"
  if ! launchctl print "gui/$(id -u)/$LABEL" > /dev/null 2>&1; then
    info "Installing background service so containers start automatically on login..."
    "$REPO_DIR/scripts/install-service.sh"
  else
    info "Background service already installed."
  fi
fi

# ── Done ──────────────────────────────────────────────────────────────
echo ""
info "Teams Meeting Insights is running!"
info ""
info "  Dashboard: http://localhost:4005"
info "  MCP endpoint: http://localhost:4005/mcp"
info ""
info "  Open the dashboard to sign in with your Microsoft account."
info "  Your first sync will run automatically after sign-in."

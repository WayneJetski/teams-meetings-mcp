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

# Validate required vars are set (not just placeholder values)
source .env 2>/dev/null || true

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

  # Check if our server is already configured
  if node -e "
    const cfg = JSON.parse(require('fs').readFileSync('$MCP_CONFIG', 'utf8'));
    const servers = cfg.mcpServers || {};
    process.exit(servers['$MCP_SERVER_NAME'] ? 0 : 1);
  " 2>/dev/null; then
    info "MCP server '$MCP_SERVER_NAME' already configured in Claude."
  else
    info "Adding MCP server '$MCP_SERVER_NAME' to Claude config..."
    node -e "
      const fs = require('fs');
      const cfg = JSON.parse(fs.readFileSync('$MCP_CONFIG', 'utf8'));
      if (!cfg.mcpServers) cfg.mcpServers = {};
      cfg.mcpServers['$MCP_SERVER_NAME'] = {
        command: 'npx',
        args: ['-y', 'mcp-remote', '$MCP_URL']
      };
      fs.writeFileSync('$MCP_CONFIG', JSON.stringify(cfg, null, 2) + '\n');
    "
    info "MCP server added. Restart Claude Code to pick up the change."
  fi
}

configure_mcp

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

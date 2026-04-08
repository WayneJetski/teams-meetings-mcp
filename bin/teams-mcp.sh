#!/usr/bin/env bash
set -euo pipefail

# Resolve the repo root from this script's real location (not the symlink)
resolve_symlink() {
  local target="$1"
  while [ -L "$target" ]; do
    local dir="$(cd "$(dirname "$target")" && pwd)"
    target="$(readlink "$target")"
    # Handle relative symlink targets
    [[ "$target" != /* ]] && target="$dir/$target"
  done
  echo "$target"
}

REAL_SCRIPT="$(resolve_symlink "${BASH_SOURCE[0]}")"
SCRIPT_DIR="$(cd "$(dirname "$REAL_SCRIPT")" && pwd)"
REPO_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
SCRIPTS_DIR="$REPO_DIR/scripts"

# ── Colors ────────────────────────────────────────────────────────────
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
CYAN='\033[0;36m'
BOLD='\033[1m'
NC='\033[0m'

VERSION="1.0.0"

usage() {
  echo -e "${BOLD}teams-mcp${NC} v${VERSION} — Teams Meeting Insights MCP Server"
  echo ""
  echo -e "${BOLD}Usage:${NC}"
  echo "  teams-mcp              Start the server (default)"
  echo "  teams-mcp start        Start the server"
  echo "  teams-mcp stop         Stop the server"
  echo "  teams-mcp logs         Show container logs"
  echo "  teams-mcp update       Pull latest changes and restart"
  echo "  teams-mcp status       Show container status"
  echo "  teams-mcp uninstall    Remove teams-mcp completely"
  echo "  teams-mcp help         Show this help message"
  echo ""
  echo -e "${BOLD}Examples:${NC}"
  echo "  teams-mcp              # Start server + configure MCP"
  echo "  teams-mcp logs -f      # Follow logs in real time"
  echo "  teams-mcp stop         # Shut down containers"
}

COMMAND="${1:-start}"
shift 2>/dev/null || true

case "$COMMAND" in
  start)
    exec "$SCRIPTS_DIR/start.sh" "$@"
    ;;
  stop)
    exec "$SCRIPTS_DIR/stop.sh" "$@"
    ;;
  logs)
    exec "$SCRIPTS_DIR/logs.sh" "$@"
    ;;
  update)
    exec "$SCRIPTS_DIR/update.sh" "$@"
    ;;
  status)
    exec "$SCRIPTS_DIR/status.sh" "$@"
    ;;
  uninstall)
    exec "$SCRIPTS_DIR/uninstall.sh" "$@"
    ;;
  help|--help|-h)
    usage
    ;;
  *)
    echo -e "${YELLOW}Unknown command:${NC} $COMMAND"
    echo ""
    usage
    exit 1
    ;;
esac

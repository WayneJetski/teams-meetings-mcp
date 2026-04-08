#!/usr/bin/env bash
set -euo pipefail

# ── Teams Meeting Insights MCP — Installer ───────────────────────────
#
# Usage:
#   curl -fsSL <raw-url>/scripts/install.sh | bash
#   curl -fsSL <raw-url>/scripts/install.sh | bash -s -- --dir ~/my-path
#
# What it does:
#   1. Checks prerequisites (git, docker, node)
#   2. Clones the repo into the current directory (or --dir)
#   3. Symlinks bin/teams-mcp.sh → /usr/local/bin/teams-mcp
#   4. Runs 'teams-mcp start' to kick things off
# ─────────────────────────────────────────────────────────────────────

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

info()  { echo -e "${GREEN}[install]${NC} $*"; }
warn()  { echo -e "${YELLOW}[install]${NC} $*"; }
error() { echo -e "${RED}[install]${NC} $*"; }

REPO_SSH="git@github.com:WayneJetski/teams-meetings-mcp.git"
REPO_HTTPS="https://github.com/WayneJetski/teams-meetings-mcp.git"
INSTALL_DIR=""
LINK_DIR="/usr/local/bin"

# ── Parse args ───────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case "$1" in
    --dir)
      INSTALL_DIR="$2"
      shift 2
      ;;
    --https)
      REPO_SSH=""  # force HTTPS
      shift
      ;;
    --help|-h)
      echo "Usage: install.sh [--dir <path>] [--https]"
      echo ""
      echo "Options:"
      echo "  --dir <path>   Clone into this directory (default: ./teams-meetings-mcp)"
      echo "  --https        Use HTTPS instead of SSH for git clone"
      exit 0
      ;;
    *)
      error "Unknown option: $1"
      exit 1
      ;;
  esac
done

# ── Prerequisites ────────────────────────────────────────────────────
check_command() {
  if ! command -v "$1" &> /dev/null; then
    error "$1 is required but not installed."
    return 1
  fi
}

info "Checking prerequisites..."
MISSING=0
check_command git    || MISSING=1
check_command docker || MISSING=1
check_command node   || MISSING=1

if ! docker compose version &> /dev/null && ! docker-compose --version &> /dev/null; then
  error "docker compose is required but not available."
  MISSING=1
fi

if [ "$MISSING" -eq 1 ]; then
  error "Please install missing prerequisites and try again."
  exit 1
fi

info "All prerequisites found."

# ── Clone ────────────────────────────────────────────────────────────
CLONE_DIR="${INSTALL_DIR:-$(pwd)/teams-meetings-mcp}"

if [ -d "$CLONE_DIR" ]; then
  if [ -d "$CLONE_DIR/.git" ] || [ -f "$CLONE_DIR/.git" ]; then
    info "Repo already exists at $CLONE_DIR — pulling latest."
    git -C "$CLONE_DIR" pull || warn "Could not pull — continuing with existing version."
  else
    error "$CLONE_DIR already exists and is not a git repo. Remove it or use --dir."
    exit 1
  fi
else
  info "Cloning into $CLONE_DIR..."
  if [ -n "$REPO_SSH" ]; then
    git clone "$REPO_SSH" "$CLONE_DIR" 2>/dev/null || {
      warn "SSH clone failed — falling back to HTTPS."
      git clone "$REPO_HTTPS" "$CLONE_DIR"
    }
  else
    git clone "$REPO_HTTPS" "$CLONE_DIR"
  fi
fi

# ── Make scripts executable ──────────────────────────────────────────
chmod +x "$CLONE_DIR/bin/teams-mcp.sh"
chmod +x "$CLONE_DIR/scripts/"*.sh

# ── Configure .env ──────────────────────────────────────────────────
ENV_FILE="$CLONE_DIR/.env"

if [ -f "$ENV_FILE" ]; then
  info ".env already exists — skipping configuration prompts."
else
  info "Setting up Azure credentials..."
  echo ""
  echo -e "${BOLD}Enter your Azure AD app registration details.${NC}"
  echo -e "  (See README.md for setup instructions)"
  echo ""

  # Read from /dev/tty so prompts work even when piped (curl | bash)
  read -rp "  Port [4005]: " INPUT_PORT < /dev/tty
  INPUT_PORT="${INPUT_PORT:-4005}"

  # Required fields — re-prompt until non-blank
  INPUT_TENANT_ID=""
  while [ -z "$INPUT_TENANT_ID" ]; do
    read -rp "  Azure Tenant ID: " INPUT_TENANT_ID < /dev/tty
    [ -z "$INPUT_TENANT_ID" ] && warn "Azure Tenant ID is required — cannot be blank."
  done

  INPUT_CLIENT_ID=""
  while [ -z "$INPUT_CLIENT_ID" ]; do
    read -rp "  Azure Client ID: " INPUT_CLIENT_ID < /dev/tty
    [ -z "$INPUT_CLIENT_ID" ] && warn "Azure Client ID is required — cannot be blank."
  done

  INPUT_CLIENT_SECRET=""
  while [ -z "$INPUT_CLIENT_SECRET" ]; do
    read -rsp "  Azure Client Secret: " INPUT_CLIENT_SECRET < /dev/tty
    echo ""
    [ -z "$INPUT_CLIENT_SECRET" ] && warn "Azure Client Secret is required — cannot be blank."
  done

  read -rp "  Session Secret (leave blank to auto-generate): " INPUT_SESSION_SECRET < /dev/tty
  echo ""

  {
    # Generate session secret if blank
    if [ -z "$INPUT_SESSION_SECRET" ]; then
      INPUT_SESSION_SECRET=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
      info "Generated random session secret."
    fi

    cp "$CLONE_DIR/.env.example" "$ENV_FILE"

    # Write values into .env (portable sed for macOS + Linux)
    sed_inplace() {
      if [[ "$OSTYPE" == "darwin"* ]]; then
        sed -i '' "$@"
      else
        sed -i "$@"
      fi
    }

    sed_inplace "s/^PORT=.*/PORT=${INPUT_PORT}/" "$ENV_FILE"
    sed_inplace "s/^AZURE_TENANT_ID=.*/AZURE_TENANT_ID=${INPUT_TENANT_ID}/" "$ENV_FILE"
    sed_inplace "s/^AZURE_CLIENT_ID=.*/AZURE_CLIENT_ID=${INPUT_CLIENT_ID}/" "$ENV_FILE"
    sed_inplace "s/^AZURE_CLIENT_SECRET=.*/AZURE_CLIENT_SECRET=${INPUT_CLIENT_SECRET}/" "$ENV_FILE"
    sed_inplace "s/^SESSION_SECRET=.*/SESSION_SECRET=${INPUT_SESSION_SECRET}/" "$ENV_FILE"

    info ".env configured."
    SKIP_START=false
  }
fi

# ── Add to PATH ──────────────────────────────────────────────────────
LINK_TARGET="$LINK_DIR/teams-mcp"
BIN_SOURCE="$CLONE_DIR/bin/teams-mcp.sh"

create_symlink() {
  if [ -L "$LINK_TARGET" ] || [ -f "$LINK_TARGET" ]; then
    info "Updating existing link at $LINK_TARGET"
    sudo ln -sf "$BIN_SOURCE" "$LINK_TARGET"
  else
    info "Creating symlink: $LINK_TARGET → $BIN_SOURCE"
    sudo ln -sf "$BIN_SOURCE" "$LINK_TARGET"
  fi
}

if [ -w "$LINK_DIR" ]; then
  ln -sf "$BIN_SOURCE" "$LINK_TARGET"
  info "Linked teams-mcp → $BIN_SOURCE"
else
  info "Need sudo to create symlink in $LINK_DIR"
  create_symlink
fi

# Verify it's accessible
if command -v teams-mcp &> /dev/null; then
  info "teams-mcp is now available on your PATH."
else
  warn "teams-mcp was linked to $LINK_TARGET but isn't on your PATH."
  warn "Add $LINK_DIR to your PATH, or run directly: $BIN_SOURCE"
fi

# ── Kick off first run ──────────────────────────────────────────────
echo ""
echo -e "${BOLD}Installation complete!${NC}"
echo ""
echo -e "  ${BOLD}Start:${NC}       teams-mcp"
echo -e "  ${BOLD}Stop:${NC}        teams-mcp stop"
echo -e "  ${BOLD}Logs:${NC}        teams-mcp logs"
echo -e "  ${BOLD}Update:${NC}      teams-mcp update"
echo -e "  ${BOLD}Status:${NC}      teams-mcp status"
echo -e "  ${BOLD}Uninstall:${NC}   teams-mcp uninstall"
echo -e "  ${BOLD}Help:${NC}        teams-mcp help"
echo ""

# SKIP_START is set during .env config if credentials were missing
if [ "${SKIP_START:-false}" = "true" ]; then
  warn "Skipping auto-start — edit $ENV_FILE with your Azure credentials, then run: teams-mcp"
else
  info "Running first-time setup..."
  exec "$BIN_SOURCE"
fi

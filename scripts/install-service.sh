#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
LABEL="com.teams-meetings-mcp"
PLIST_PATH="$HOME/Library/LaunchAgents/${LABEL}.plist"
DAEMON_SCRIPT="$REPO_DIR/scripts/daemon.sh"
LOG_DIR="$REPO_DIR/logs"

GREEN='\033[0;32m'
RED='\033[0;31m'
NC='\033[0m'
info()  { echo -e "${GREEN}[service]${NC} $*"; }
error() { echo -e "${RED}[service]${NC} $*"; }

# Ensure daemon script is executable
chmod +x "$DAEMON_SCRIPT"

# Create log directory
mkdir -p "$LOG_DIR"

# Unload existing agent if present
if launchctl print "gui/$(id -u)/$LABEL" > /dev/null 2>&1; then
  info "Unloading existing service..."
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi

# Generate the plist with absolute paths
cat > "$PLIST_PATH" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/bash</string>
    <string>${DAEMON_SCRIPT}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${REPO_DIR}</string>
  <key>StandardOutPath</key>
  <string>${LOG_DIR}/daemon.stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${LOG_DIR}/daemon.stderr.log</string>
</dict>
</plist>
EOF

# Load the agent
launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH"

info "Service installed and loaded."
info "Teams MCP will start automatically on login."
info "Logs: $LOG_DIR/daemon.{stdout,stderr}.log"
info ""
info "To uninstall: ./scripts/uninstall-service.sh"

#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}Container status:${NC}"
docker compose ps

echo ""

# Health check. A degraded server still answers — writes are blocked but reads,
# MCP tools and the dashboard all work — so it must not read as "not responding".
HEALTH=$(curl -sf http://localhost:4005/health 2>/dev/null || true)
if [ -z "$HEALTH" ]; then
  echo -e "MCP server: ${RED}not responding${NC}"
elif echo "$HEALTH" | grep -q '"status":"ok"'; then
  echo -e "MCP server: ${GREEN}healthy${NC}"
else
  echo -e "MCP server: ${YELLOW}degraded${NC}"
  BLOCKS=$(echo "$HEALTH" | grep -o '"blocks":\[[^]]*\]' | sed 's/"blocks"://')
  [ "$BLOCKS" != "[]" ] && echo "  writes blocked: $BLOCKS"
  echo "$HEALTH" | grep -o '"usedPercent":[0-9]*' | sed 's/"usedPercent":/  disk used: /;s/$/%/'
fi

# Elasticsearch is not exposed on the host, so check the container's health
# state (reported by the compose healthcheck) instead of hitting the port.
if [ "$(docker inspect --format '{{.State.Health.Status}}' meetings-es 2>/dev/null)" = "healthy" ]; then
  echo -e "Elasticsearch: ${GREEN}healthy${NC}"
else
  echo -e "Elasticsearch: ${RED}not responding${NC}"
fi

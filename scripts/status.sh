#!/usr/bin/env bash
set -euo pipefail

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

echo -e "${BOLD}Container status:${NC}"
docker compose ps

echo ""

# Health check
if curl -sf http://localhost:4005/health > /dev/null 2>&1; then
  echo -e "MCP server: ${GREEN}healthy${NC}"
else
  echo -e "MCP server: ${RED}not responding${NC}"
fi

# Elasticsearch is not exposed on the host, so check the container's health
# state (reported by the compose healthcheck) instead of hitting the port.
if [ "$(docker inspect --format '{{.State.Health.Status}}' meetings-es 2>/dev/null)" = "healthy" ]; then
  echo -e "Elasticsearch: ${GREEN}healthy${NC}"
else
  echo -e "Elasticsearch: ${RED}not responding${NC}"
fi

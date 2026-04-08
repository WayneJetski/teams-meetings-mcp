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

if curl -sf http://localhost:9200/_cluster/health > /dev/null 2>&1; then
  echo -e "Elasticsearch: ${GREEN}healthy${NC}"
else
  echo -e "Elasticsearch: ${RED}not responding${NC}"
fi

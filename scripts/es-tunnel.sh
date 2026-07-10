#!/usr/bin/env bash
set -euo pipefail

# ── Elasticsearch tunnel ─────────────────────────────────────────────
# Elasticsearch is not exposed on the host — it only listens inside the Docker
# network. This script opens a TEMPORARY tunnel from a localhost port to the
# `elasticsearch` container for ad-hoc direct access (debugging, one-off
# queries). It stays open until you press Ctrl-C, then tears itself down.
#
# Usage:
#   ./scripts/es-tunnel.sh [local_port]   # default 9200
#
# It runs a small socat proxy container attached to the same Docker network as
# Elasticsearch. Nothing about the ES container's own (unexposed) config changes.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

PORT="${1:-9200}"
ES_CONTAINER="meetings-es"

# Validate the port is a bare integer so it can't alter the -p bind address.
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo -e "${RED}Port must be a number (got: '$PORT').${NC}"
  echo -e "Usage: ${BOLD}$(basename "$0") [local_port]${NC}"
  exit 1
fi

# The container must be running to discover its network.
if ! docker inspect "$ES_CONTAINER" >/dev/null 2>&1; then
  echo -e "${RED}Elasticsearch container '$ES_CONTAINER' is not running.${NC}"
  echo -e "Start it first: ${BOLD}teams-mcp start${NC}"
  exit 1
fi

NETWORK=$(docker inspect "$ES_CONTAINER" \
  --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}}{{"\n"}}{{end}}' 2>/dev/null | head -1 || true)
if [ -z "$NETWORK" ]; then
  echo -e "${RED}Could not determine the Docker network for '$ES_CONTAINER'.${NC}"
  exit 1
fi

echo -e "${GREEN}Tunneling ${BOLD}127.0.0.1:${PORT}${NC}${GREEN} -> elasticsearch:9200${NC} (network: $NETWORK)"
echo -e "Press ${BOLD}Ctrl-C${NC} to close the tunnel."
echo ""
echo -e "${YELLOW}Example (reads ES_SECRET from .env, does not print it):${NC}"
echo "  curl -u \"elastic:\$(grep '^ES_SECRET=' .env | cut -d= -f2-)\" http://localhost:${PORT}/_cluster/health?pretty"
echo ""

# socat forwards the container-side :9200 listener (published to the host via
# -p) to the elasticsearch service inside the network. --rm cleans up on exit.
exec docker run --rm -it \
  --network "$NETWORK" \
  -p "127.0.0.1:${PORT}:9200" \
  alpine/socat \
  tcp-listen:9200,fork,reuseaddr tcp-connect:elasticsearch:9200

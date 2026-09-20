#!/usr/bin/env bash
set -euo pipefail

# ── Integration tests ────────────────────────────────────────────────
# Runs test/integration/ against a real Elasticsearch, because the query layer
# cannot be verified any other way: Elasticsearch answers a query against a
# nested field with zero hits rather than an error, so a wrong query is
# indistinguishable from an empty index.
#
# Usage:
#   ./scripts/test-integration.sh [port]        # default 19200
#   npm run test:integration
#
# By default this starts a THROWAWAY Elasticsearch container, runs the suite
# against it, and removes it again — including when the tests fail or you press
# Ctrl-C. Nothing touches the real `meetings-es` container or its data.
#
# If ELASTICSEARCH_URL is already set, that node is used as-is and no container
# is started or stopped. That is how CI runs it, against a service container.

REPO_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "$REPO_DIR"

GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
BOLD='\033[1m'
NC='\033[0m'

# ── Use an Elasticsearch that already exists ─────────────────────────

if [ -n "${ELASTICSEARCH_URL:-}" ]; then
  echo -e "${GREEN}Using the Elasticsearch already configured at ${BOLD}${ELASTICSEARCH_URL}${NC}"
  echo ""
  exec node --test test/integration/*.test.js
fi

# ── Otherwise, run one just for this suite ───────────────────────────

PORT="${1:-19200}"
CONTAINER="meetings-es-itest"

# Validate the port is a bare integer so it cannot alter the -p bind address.
if ! [[ "$PORT" =~ ^[0-9]+$ ]]; then
  echo -e "${RED}Port must be a number (got: '$PORT').${NC}"
  echo -e "Usage: ${BOLD}$(basename "$0") [port]${NC}"
  exit 1
fi

if ! docker info >/dev/null 2>&1; then
  echo -e "${RED}Docker is not available.${NC}"
  echo -e "Start Docker, or point this at an existing node:"
  echo -e "  ${BOLD}ELASTICSEARCH_URL=http://host:9200 ELASTICSEARCH_PASSWORD=... npm run test:integration${NC}"
  exit 1
fi

if docker inspect "$CONTAINER" >/dev/null 2>&1; then
  echo -e "${YELLOW}Removing a leftover '${CONTAINER}' container from an earlier run.${NC}"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
fi

# Match the version docker-compose runs, so the suite exercises the same
# mapping and query behaviour production does.
ES_IMAGE=$(grep -m1 'image: docker.elastic.co/elasticsearch' docker-compose.yml | awk '{print $2}')
if [ -z "$ES_IMAGE" ]; then
  echo -e "${RED}Could not read the Elasticsearch image from docker-compose.yml.${NC}"
  exit 1
fi

# Generated per run and never printed: the container is throwaway, but a
# password baked into a tracked file would not stay throwaway.
ES_PASSWORD=$(node -e "console.log(require('crypto').randomBytes(24).toString('hex'))")

cleanup() {
  echo ""
  echo -e "${YELLOW}Removing the throwaway Elasticsearch container...${NC}"
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

echo -e "${GREEN}Starting a throwaway Elasticsearch (${ES_IMAGE}) on ${BOLD}127.0.0.1:${PORT}${NC}"

# Bound to loopback: this node holds test fixtures, but it should still not be
# reachable from outside the machine.
docker run -d --rm --name "$CONTAINER" \
  -p "127.0.0.1:${PORT}:9200" \
  -e discovery.type=single-node \
  -e xpack.security.enabled=true \
  -e xpack.security.http.ssl.enabled=false \
  -e "ELASTIC_PASSWORD=${ES_PASSWORD}" \
  -e "ES_JAVA_OPTS=-Xms512m -Xmx1g" \
  "$ES_IMAGE" >/dev/null

printf "Waiting for it to accept connections"
READY=false
for _ in $(seq 1 90); do
  if curl -sf -u "elastic:${ES_PASSWORD}" "http://127.0.0.1:${PORT}/_cluster/health" >/dev/null 2>&1; then
    READY=true
    break
  fi
  printf "."
  sleep 1
done
echo ""

if [ "$READY" != true ]; then
  echo -e "${RED}Elasticsearch did not become ready in 90s.${NC}"
  echo -e "Container logs:"
  docker logs --tail 30 "$CONTAINER" 2>&1 || true
  exit 1
fi

echo -e "${GREEN}Ready. Running the integration suite...${NC}"
echo ""

# Each run indexes into its own meetings-itest-* index and deletes it afterwards.
export ELASTICSEARCH_URL="http://127.0.0.1:${PORT}"
export ELASTICSEARCH_PASSWORD="$ES_PASSWORD"

# Failing tests must still tear the container down, and must still fail the
# command — so take the status by hand rather than letting errexit out early.
set +e
node --test test/integration/*.test.js
STATUS=$?
set -e

exit "$STATUS"

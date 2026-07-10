#!/usr/bin/env bash
# Idempotent Elasticsearch credential enforcement.
#
# Sourced by start.sh / update.sh. Must be called from the repo directory (so
# `docker compose` resolves) with ES_SECRET set in the environment.

# ensure_es_password
#
# Guarantees the built-in `elastic` user's password equals $ES_SECRET.
# Works for both fresh installs and existing (previously-unsecured) data
# volumes, and is safe to run repeatedly:
#   - Normal case: the ES Docker image re-applies ELASTIC_PASSWORD on every
#     start (fresh AND existing volumes), so the auth check passes and this is
#     a no-op.
#   - Fallback: if `elastic` doesn't authenticate with ES_SECRET for any reason
#     (e.g. a password set out of band), reset it to the target. No data is
#     touched either way.
ensure_es_password() {
  local secret="${ES_SECRET:-}"
  if [ -z "$secret" ]; then
    echo "[es-security] ES_SECRET is empty — cannot verify Elasticsearch auth" >&2
    return 1
  fi

  # 1. Wait for the ES HTTP layer to respond at all (200 or 401 both mean "up").
  local code="" i
  for i in $(seq 1 30); do
    code=$(docker compose exec -T elasticsearch \
      curl -s -o /dev/null -w '%{http_code}' http://localhost:9200 2>/dev/null || true)
    case "$code" in
      200|401) break ;;
    esac
    sleep 2
  done
  if [ "$code" != "200" ] && [ "$code" != "401" ]; then
    echo "[es-security] Elasticsearch HTTP not responding (last code: ${code:-none})" >&2
    return 1
  fi

  # 2. Already authenticating with the target password? Nothing to do.
  if es_auth_ok; then
    return 0
  fi

  # 3. Set the elastic password to the target. `elasticsearch-reset-password`
  #    runs locally against the node and does NOT need the current password.
  #    The new value is read from the container's own $ELASTIC_PASSWORD env, so
  #    the secret never appears on the host command line.
  echo "[es-security] Setting Elasticsearch 'elastic' password from ES_SECRET..."
  local reset_rc=0
  docker compose exec -T elasticsearch sh -c '
    printf "y\n%s\n%s\n" "$ELASTIC_PASSWORD" "$ELASTIC_PASSWORD" \
      | bin/elasticsearch-reset-password -u elastic -i -s -f
  ' >/dev/null 2>&1 || reset_rc=$?

  # 4. Re-verify.
  if es_auth_ok; then
    echo "[es-security] Elasticsearch credentials verified."
    return 0
  fi

  echo "[es-security] WARNING: could not verify Elasticsearch auth for the 'elastic' user (reset exit code: ${reset_rc})." >&2
  echo "[es-security] Reset it manually with:" >&2
  echo "[es-security]   docker compose exec elasticsearch bin/elasticsearch-reset-password -u elastic -i" >&2
  echo "[es-security] then set ES_SECRET in .env to the new value and restart." >&2
  return 1
}

# es_auth_ok — returns 0 if the `elastic` user authenticates with the password
# currently configured on the container ($ELASTIC_PASSWORD). curl runs inside
# the container and references the secret by name, so the value never lands in
# the host process list.
#
# Invariant: the container's $ELASTIC_PASSWORD equals the .env ES_SECRET,
# because callers always `docker compose up` (which re-renders ELASTIC_PASSWORD
# from ${ES_SECRET}) immediately before invoking this. That is why checking the
# container-side value is equivalent to checking .env's value.
es_auth_ok() {
  local code
  code=$(docker compose exec -T elasticsearch sh -c \
    'curl -s -o /dev/null -w "%{http_code}" -u "elastic:$ELASTIC_PASSWORD" http://localhost:9200' \
    2>/dev/null || true)
  [ "$code" = "200" ]
}

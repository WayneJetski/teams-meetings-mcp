#!/usr/bin/env bash
# Shared helper for managing auto-generated secrets in the .env file.
#
# Sourced by install.sh / start.sh / update.sh so they share one code path for
# generating and backfilling secret values (currently ES_SECRET).

# ensure_env_secret <VAR_NAME> <ENV_FILE>
#
# Ensures <VAR_NAME> exists in <ENV_FILE> with a strong random hex value.
# - If the var is missing/empty/a known placeholder, generates a 32-byte hex
#   value and writes it (in place if the key exists, appended otherwise).
# - Uses hex (not base64) so the value is safe for sed, shell, and URLs.
# - Exports the resolved value into the current shell so callers can use it
#   immediately (e.g. to pass to docker compose or es-security helpers).
ensure_env_secret() {
  local var_name="$1"
  local env_file="$2"
  local os="${OSTYPE:-}"

  local current=""
  if [ -f "$env_file" ]; then
    current=$(grep -E "^${var_name}=" "$env_file" | head -1 | cut -d= -f2- || true)
    # Strip surrounding single or double quotes if present.
    current="${current%\"}"; current="${current#\"}"
    current="${current%\'}"; current="${current#\'}"
  fi

  if [ -z "$current" ] || [ "$current" = "change-me-to-a-random-string" ]; then
    if command -v node >/dev/null 2>&1; then
      current=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
    elif command -v openssl >/dev/null 2>&1; then
      current=$(openssl rand -hex 32)
    else
      echo "[env-secrets] need 'node' or 'openssl' on PATH to generate ${var_name}" >&2
      return 1
    fi
    if [ -f "$env_file" ] && grep -qE "^${var_name}=" "$env_file"; then
      # Use | as the sed delimiter — the hex value never contains it.
      if [[ "$os" == darwin* ]]; then
        sed -i '' "s|^${var_name}=.*|${var_name}=${current}|" "$env_file"
      else
        sed -i "s|^${var_name}=.*|${var_name}=${current}|" "$env_file"
      fi
    else
      echo "${var_name}=${current}" >> "$env_file"
    fi
  fi

  export "${var_name}=${current}"
}

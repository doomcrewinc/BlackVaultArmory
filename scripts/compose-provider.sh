# shellcheck shell=bash
#
# Shared by install.sh and update.sh: reads the database provider recorded in
# .env. Source it; do not run it. install.bat and update.bat mirror it.
#
# There is only one compose file, so nothing here picks a file: plain
# `docker compose` reads .env, and COMPOSE_PROFILES=postgres in .env is what
# turns PostgreSQL on. The provider is only used for the preflight checks.
#
# The database keys in .env are BLACKVAULT_DB_PROVIDER, BLACKVAULT_POSTGRES_PASSWORD
# and BLACKVAULT_DATABASE_URL, never the generic names: Compose lets a variable
# exported in the shell override .env, and DATABASE_URL is commonly exported.
# docker-compose.yml maps them to the names the container uses.

# Value of KEY in ./.env (last line wins), with surrounding whitespace, a
# trailing CR and one pair of matching quotes removed. Inner spaces are kept,
# so DATA_DIR paths with spaces survive. Empty when unset or no .env.
env_value() {
  local line="" value
  if [ -f .env ]; then
    line=$(grep "^$1=" .env | tail -n 1 || true)
  fi
  value=${line#*=}
  value=${value%$'\r'}
  value="${value#"${value%%[![:space:]]*}"}"
  value="${value%"${value##*[![:space:]]}"}"
  case "$value" in
    \"*\") value=${value#\"}; value=${value%\"} ;;
    \'*\') value=${value#\'}; value=${value%\'} ;;
  esac
  printf '%s\n' "$value"
}

# Provider recorded in an existing .env. Installs made before PostgreSQL
# support have no BLACKVAULT_DB_PROVIDER line (or no .env at all) and were
# always SQLite. A plain DB_PROVIDER line is ignored, as docker-compose.yml
# ignores it.
provider_from_env() {
  local value
  value=$(env_value BLACKVAULT_DB_PROVIDER | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
  case "$value" in
    "" | sqlite) echo "sqlite" ;;
    postgresql) echo "postgres" ;;
    *) echo "$value" ;;
  esac
}

# Prints a warning when .env says PostgreSQL but lacks a key the single
# compose file needs to actually run it. Returns 0 when complete.
check_postgres_env() {
  local missing=""
  case ",$(env_value COMPOSE_PROFILES | tr -d '[:space:]')," in
    *,postgres,*) ;;
    *) missing="$missing COMPOSE_PROFILES=postgres" ;;
  esac
  [ -n "$(env_value BLACKVAULT_POSTGRES_PASSWORD)" ] || missing="$missing BLACKVAULT_POSTGRES_PASSWORD"
  case "$(env_value BLACKVAULT_DATABASE_URL)" in
    postgres://* | postgresql://*) ;;
    *) missing="$missing BLACKVAULT_DATABASE_URL=postgresql://..." ;;
  esac
  [ -z "$missing" ] && return 0
  echo "⚠  WARNING: .env says BLACKVAULT_DB_PROVIDER=postgres but is missing:$missing"
  echo "   A PostgreSQL install needs all four of these in .env:"
  echo "     COMPOSE_PROFILES=postgres"
  echo "     BLACKVAULT_DB_PROVIDER=postgres"
  echo "     BLACKVAULT_POSTGRES_PASSWORD=<48 hex characters>"
  echo "     BLACKVAULT_DATABASE_URL=postgresql://blackvault:<same password>@db:5432/blackvault"
  echo "   See .env.example. If this is a SQLite install, set BLACKVAULT_DB_PROVIDER=sqlite instead."
  return 1
}

# ── Docker Compose version floor ─────────────────────────────
# docker-compose.yml uses depends_on.required: false (so the db service can be
# off on SQLite). That needs Docker Compose v2.20 or newer: older v2 rejects
# the file, and v1 (`docker-compose`) cannot parse it. install.bat and
# update.bat mirror this check in :require_compose.
COMPOSE_MIN_VERSION="2.20"

# 0 when the version string (e.g. "2.29.7", "v2.20.0", "5.1.2", as printed
# by `docker compose version --short`) is at least COMPOSE_MIN_VERSION.
# Anything unparseable, including a v1 "docker-compose version 1.29.2, ..."
# line, fails.
compose_version_ok() {
  local v="${1:-}" major minor rest
  v="${v#"${v%%[![:space:]]*}"}"
  v="${v%"${v##*[![:space:]]}"}"
  v="${v#[vV]}"
  major="${v%%.*}"
  rest="${v#*.}"
  [ "$rest" != "$v" ] || return 1
  minor="${rest%%[!0-9]*}"
  case "$major" in "" | *[!0-9]*) return 1 ;; esac
  [ -n "$minor" ] || return 1
  major=$((10#$major))
  minor=$((10#$minor))
  [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 20 ]; }
}

# Sets COMPOSE="docker compose", or prints why not and exits 1. Call it before
# touching anything. The v1 `docker-compose` fallback is gone on purpose.
require_compose() {
  local version
  if ! version=$(docker compose version --short 2>/dev/null) || [ -z "$version" ]; then
    echo "ERROR: BlackVault needs Docker Compose v$COMPOSE_MIN_VERSION or newer, run as"
    echo "       'docker compose' (the Compose v2 plugin)."
    if command -v docker-compose >/dev/null 2>&1; then
      echo "       Only the old 'docker-compose' ($(docker-compose version --short 2>/dev/null || echo v1)) was found;"
      echo "       it cannot read BlackVault's docker-compose.yml."
    fi
    echo "       Upgrade Docker Desktop, or on Linux install the docker-compose-plugin"
    echo "       package: https://docs.docker.com/compose/install/linux/"
    echo "       Nothing was changed."
    exit 1
  fi
  if ! compose_version_ok "$version"; then
    echo "ERROR: Docker Compose $version is too old. BlackVault needs v$COMPOSE_MIN_VERSION or newer."
    echo "       Upgrade Docker Desktop, or on Linux update the docker-compose-plugin"
    echo "       package: https://docs.docker.com/compose/install/linux/"
    echo "       Nothing was changed."
    exit 1
  fi
  # shellcheck disable=SC2034 # read by install.sh / update.sh, which source this file
  COMPOSE="docker compose"
}

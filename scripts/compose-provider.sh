# shellcheck shell=bash
#
# Shared by install.sh and update.sh: reads the database provider recorded in
# .env. Source it; do not run it. install.bat and update.bat mirror it.
#
# There is only one compose file, so nothing here picks a file: plain
# `docker compose` reads .env, and COMPOSE_PROFILES=postgres in .env is what
# turns PostgreSQL on. The provider is only used for the preflight checks.

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
# support have no DB_PROVIDER line (or no .env at all) and were always SQLite.
provider_from_env() {
  local value
  value=$(env_value DB_PROVIDER | tr -d '[:space:]' | tr '[:upper:]' '[:lower:]')
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
  [ -n "$(env_value POSTGRES_PASSWORD)" ] || missing="$missing POSTGRES_PASSWORD"
  case "$(env_value DATABASE_URL)" in
    postgres://* | postgresql://*) ;;
    *) missing="$missing DATABASE_URL=postgresql://..." ;;
  esac
  [ -z "$missing" ] && return 0
  echo "⚠  WARNING: .env says DB_PROVIDER=postgres but is missing:$missing"
  echo "   A PostgreSQL install needs all four of these in .env:"
  echo "     COMPOSE_PROFILES=postgres"
  echo "     DB_PROVIDER=postgres"
  echo "     POSTGRES_PASSWORD=<48 hex characters>"
  echo "     DATABASE_URL=postgresql://blackvault:<same password>@db:5432/blackvault"
  echo "   See .env.example. If this is a SQLite install, set DB_PROVIDER=sqlite instead."
  return 1
}

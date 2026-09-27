# shellcheck shell=bash
# Public-URL and direct-access prompts, sourced by install.sh and update.sh.
# install.bat / update.bat duplicate this logic: change them together.
# Prompts go to stderr so callers can capture the answer from stdout.
# The app validates BLACKVAULT_PUBLIC_URL authoritatively at startup; this is
# a shape check to catch typos before a rebuild.

valid_public_url() {
  [[ "$1" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?/?$ ]]
}

# set_env_value FILE KEY VALUE — replace or append KEY=VALUE, keep FILE.bak.
# grep -v, not sed: the value is never interpreted, so & | / are safe.
set_env_value() {
  local file="$1" key="$2" value="$3" tmp
  tmp="$(mktemp "${file}.XXXXXX")"
  cp "$file" "${file}.bak"
  grep -v "^${key}=" "$file" > "$tmp" || true
  printf '%s=%s\n' "$key" "$value" >> "$tmp"
  cat "$tmp" > "$file"
  rm -f "$tmp"
}

prompt_yes_no() {
  local question="$1" default="$2" hint answer
  if [ "$default" = "y" ]; then hint="[Y/n]"; else hint="[y/N]"; fi
  while true; do
    read -rp "$question $hint: " answer >&2 || answer=""
    case "$(printf '%s' "${answer:-$default}" | tr '[:upper:]' '[:lower:]')" in
      y|yes) echo y; return ;;
      n|no) echo n; return ;;
      *) echo "  Please answer y or n." >&2 ;;
    esac
  done
}

prompt_public_url() {
  local current="${1:-}" url
  if [ -n "$current" ]; then
    echo "" >&2
    echo "Public URL is: $current" >&2
    if [ "$(prompt_yes_no "Is this still current?" y)" = "y" ]; then
      echo "$current"
      return
    fi
  fi
  echo "" >&2
  echo "Public URL: the address people open BlackVault at, normally your reverse" >&2
  echo "proxy's HTTPS address, e.g. https://vault.example.com" >&2
  while true; do
    # A failed `read` here means EOF (stdin closed), not "the user typed
    # nothing" — that case sets $url to an empty string and lets the loop
    # re-prompt below. Conflating the two ("|| url=\"\"") re-prompts forever
    # once stdin is closed, which hangs any unattended run. Abort instead.
    if ! read -rp "Public URL: " url >&2; then
      echo "" >&2
      echo "No input received; BLACKVAULT_PUBLIC_URL is required. Aborting." >&2
      return 1
    fi
    url="$(printf '%s' "$url" | tr -d '[:space:]')"
    if valid_public_url "$url"; then
      echo "$url"
      return
    fi
    echo "  The URL must start with http:// or https:// and have no path, e.g. https://vault.example.com" >&2
  done
}

prompt_trusted_proxies() {
  local proxies
  echo "" >&2
  echo "Trusted proxies: IPs, CIDR ranges or host names your reverse proxy connects" >&2
  echo "from, comma-separated (e.g. 172.28.0.0/16). Leave blank if you have none yet." >&2
  read -rp "Trusted proxies []: " proxies >&2 || proxies=""
  printf '%s\n' "$(printf '%s' "$proxies" | tr -d '[:space:]')"
}

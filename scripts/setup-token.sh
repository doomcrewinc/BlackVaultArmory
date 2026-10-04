# shellcheck shell=bash
# First-time setup token, sourced by install.sh and update.sh after the
# container has started. install.bat / update.bat duplicate this logic in
# :show_setup_token: change them together.
#
# While no admin account exists, the app prints at every start:
#   [auth] Setup token: XXXX-XXXX-XXXX-XXXX — create the first admin at <PUBLIC_URL>/setup
# with a NEW token each time, so only the last such line in the log is valid.
# When the first admin is created it prints, once:
#   [auth] First admin created: first-time setup is closed
# and from then on it prints no token line at a start. An update that
# changes nothing keeps the container and its log, so the spent token line is
# still there: a token is shown only when no "First admin created" line
# follows it, i.e. when the LAST line of either kind is a token line.
# Only the XXXX-XXXX-XXXX-XXXX code is taken from the log; the text around it
# is plain ASCII, as in the .bat twin (the em dash garbles in cmd.exe).

# show_setup_token PUBLIC_URL — needs $COMPOSE (set by require_compose).
# Never fails: a missing log or container just means nothing is printed.
show_setup_token() {
  local url="${1%/}" line token
  line=$($COMPOSE logs blackvault 2>/dev/null | grep -F -e '[auth] Setup token:' -e '[auth] First admin created' | tail -n 1) || true
  token=$(printf '%s\n' "$line" | grep -oE 'Setup token: [A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}-[A-Z0-9]{4}' | head -n 1) || true
  token="${token#Setup token: }"
  [ -n "$token" ] || return 0
  echo "  ============================================================"
  echo "   First-time setup: open $url/setup"
  echo "   and enter the setup token: $token"
  echo "  ============================================================"
}

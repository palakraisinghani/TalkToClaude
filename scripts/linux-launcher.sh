#!/bin/sh
# "ClaudeCall" in the Linux app menu, and the `claudecall` command.
#
# Installed from the .deb this lives in /opt/claudecall (with /usr/bin/claudecall pointing here);
# from the .tar.xz, in ~/.local/share/claudecall. Either way it is a bundled copy — its own Node,
# the server and the page beside it — and it does what the Mac app does on opening:
#   - sets ClaudeCall up as this user's background service (systemd --user) the first time, and
#     again after an update, keeping settings, projects and the access code;
#   - checks the service is running this copy's build, restarting it if not;
#   - opens ClaudeCall: in a window of its own when a Chromium browser is there, else the browser.
CONF="$HOME/.config/claudecall"
UNIT=${CLAUDECALL_LABEL:-claudecall}.service
UNIT_FILE="$HOME/.config/systemd/user/$UNIT"
HERE=$(dirname "$(readlink -f "$0")")
mkdir -p "$CONF"
LOG="$CONF/launcher.log"

say() {
  echo "$1" >&2
  command -v notify-send >/dev/null 2>&1 && notify-send "ClaudeCall" "$1" || true
}
get() { sed -n "s/^$1=//p" "$CONF/env" 2>/dev/null | tail -1 | sed 's/^"\(.*\)"$/\1/'; }

# ---------- set up or update this user's service, from this copy ----------
BUILD=""
if [ -x "$HERE/node/bin/node" ] && [ -d "$HERE/app" ]; then
  BUILD=$(cat "$HERE/build" 2>/dev/null || cat "$HERE/version" 2>/dev/null)
  if [ ! -f "$CONF/env" ] || [ ! -f "$UNIT_FILE" ] || ! grep -qF "$HERE/node/bin/node" "$UNIT_FILE" \
     || [ "$(cat "$CONF/app-version" 2>/dev/null)" != "$BUILD" ]; then
    # Started from the app menu, PATH is the desktop's: add the places claude is usually
    # installed, and what a login shell would have, so the service finds claude and git
    LOGIN_PATH=$("${SHELL:-/bin/sh}" -lc 'printf %s "$PATH"' 2>/dev/null | tail -n 1)
    export PATH="${LOGIN_PATH:+$LOGIN_PATH:}$PATH:$HOME/.local/bin:$HOME/.claude/local:/usr/local/bin"
    export CLAUDECALL_NODE="$HERE/node/bin/node"
    export CLAUDECALL_PORT=3747
    export BUDDY_HOME="$HOME/ClaudeCall"
    export BUDDY_DATA="${XDG_DATA_HOME:-$HOME/.local/share}/claudecall/data"
    export BUDDY_MODEL_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/claudecall/models"
    echo "--- $(date) setting up the service from $HERE ($BUILD)" >>"$LOG"
    if ! sh "$HERE/app/scripts/service.sh" install >>"$LOG" 2>&1; then
      say "ClaudeCall could not set itself up. Details: $LOG"
      exit 1
    fi
    printf '%s\n' "$BUILD" >"$CONF/app-version"
  fi
fi

PORT=$(get PORT); PORT=${PORT:-3747}
SCHEME=http
[ "$(get BUDDY_HOST)" = 0.0.0.0 ] && SCHEME=https
running() { curl -ksf --max-time 3 "$SCHEME://localhost:$PORT/version" 2>/dev/null; }
up() { [ -n "$(running)" ]; }

# ---------- running, and this build? ----------
want_ok() { if [ -n "$BUILD" ]; then [ "$(running)" = "$BUILD" ]; else up; fi; }
if ! want_ok; then
  systemctl --user restart "$UNIT" 2>/dev/null || systemctl --user start "$UNIT" 2>/dev/null
  i=0
  while ! want_ok && [ $i -lt 80 ]; do sleep 0.5; i=$((i + 1)); done
fi
if ! want_ok; then
  say "ClaudeCall did not start. See: journalctl --user -u $UNIT"
  exit 1
fi

# the code travels after the #, which never leaves the browser; the page drops it at once
[ -n "${CLAUDECALL_NO_OPEN:-}" ] && exit 0
URL="$SCHEME://localhost:$PORT/#code=$(get BUDDY_TOKEN)"
# a window of its own, no tabs or address bar, when a Chromium-based browser is there to give one
for b in google-chrome google-chrome-stable chromium chromium-browser microsoft-edge brave-browser; do
  if command -v "$b" >/dev/null 2>&1; then
    "$b" --app="$URL" --class=ClaudeCall >/dev/null 2>&1 &
    exit 0
  fi
done
xdg-open "$URL" >/dev/null 2>&1 &

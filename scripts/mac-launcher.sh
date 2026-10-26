#!/bin/sh
# What opening ClaudeCall.app does (scripts/build-mac.sh puts it in the app as Contents/MacOS/ClaudeCall).
#
# Makes sure ClaudeCall is running as a background service from this copy of the app — installing
# it the first time, moving it over after an update or a move — and opens it in the browser.
# The service keeps running after this exits, as it does when installed from a terminal.

RES=$(cd "$(dirname "$0")/../Resources" && pwd)
APPDIR="$RES/app"
LOG="$HOME/Library/Logs/ClaudeCall-launcher.log"
SUPPORT="$HOME/Library/Application Support/ClaudeCall"
# the app's own settings and home: a clean start, apart from any copy run from source
CONF="$SUPPORT"
LABEL=${CLAUDECALL_LABEL:-com.claudecall}
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$(dirname "$LOG")" "$CONF" "$SUPPORT"
exec >>"$LOG" 2>&1
echo "--- $(date) opening $(cat "$RES/version")"

alert() {
  osascript -e "display alert \"ClaudeCall\" message \"$1\" as critical" >/dev/null 2>&1 || true
}

# Opened from the disk image (or from where macOS puts a downloaded app it has not let out of
# quarantine yet): a service pointed in there breaks the moment the image is ejected. Copy the app
# to Applications and open that copy instead.
BUNDLE=$(cd "$RES/../.." && pwd)
case "$BUNDLE" in
  /Volumes/* | */AppTranslocation/*)
    echo "opened from $BUNDLE: offering to move it to Applications"
    DEST_APP="/Applications/ClaudeCall.app"
    [ -w /Applications ] || DEST_APP="$HOME/Applications/ClaudeCall.app"
    if osascript -e 'display dialog "ClaudeCall needs to be in your Applications folder to run in the background.\n\nCopy it there and open it?" with title "ClaudeCall" buttons {"Cancel", "Copy and Open"} default button 2 with icon note' >/dev/null 2>&1; then
      mkdir -p "$(dirname "$DEST_APP")"
      rm -rf "$DEST_APP"
      if ditto "$BUNDLE" "$DEST_APP"; then
        xattr -dr com.apple.quarantine "$DEST_APP" 2>/dev/null || true
        echo "copied to $DEST_APP"
        open "$DEST_APP"
        # the disk image is no longer needed
        case "$BUNDLE" in /Volumes/*) (sleep 2; hdiutil detach "$(dirname "$BUNDLE")" -quiet 2>/dev/null) & ;; esac
      else
        alert "ClaudeCall could not be copied to $(dirname "$DEST_APP"). Drag it there from the disk image, then open it from there."
      fi
    fi
    exit 0
    ;;
esac

# Opened from Finder, the PATH is the bare system one: take the one your terminal has, so the
# service finds claude, git and the rest the way you would
LOGIN_PATH=$("${SHELL:-/bin/zsh}" -lic 'printf %s "$PATH"' 2>/dev/null | tail -n 1)
export PATH="${LOGIN_PATH:+$LOGIN_PATH:}$PATH:$HOME/.local/bin:$HOME/.claude/local:/opt/homebrew/bin:/usr/local/bin"

export CLAUDECALL_NODE="$RES/node/bin/node"
export CLAUDECALL_CONF="$CONF"
export CLAUDECALL_PORT=3747
export BUDDY_HOME="$HOME/ClaudeCall"
export BUDDY_DATA="$SUPPORT"
export BUDDY_MODEL_CACHE="$HOME/Library/Caches/ClaudeCall/models"

# installed from this copy, at this version? if not, (re)install: settings and the code are kept
VERSION=$(cat "$RES/version")
if ! grep -q "$CLAUDECALL_NODE" "$PLIST" 2>/dev/null || ! grep -qF "$CONF/env" "$PLIST" 2>/dev/null || [ "$(cat "$CONF/app-version" 2>/dev/null)" != "$VERSION" ]; then
  echo "installing the service from $RES"
  if ! sh "$APPDIR/scripts/service.sh" install; then
    alert "ClaudeCall could not start. Details are in ~/Library/Logs/ClaudeCall-launcher.log"
    exit 1
  fi
  printf '%s\n' "$VERSION" >"$CONF/app-version"
fi

get() { sed -n "s/^$1=//p" "$CONF/env" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
PORT=$(get PORT); PORT=${PORT:-3747}
SCHEME=http
[ "$(get BUDDY_HOST)" = 0.0.0.0 ] && SCHEME=https

# not answering (stopped, or crashed and given up on): start it again
if ! curl -ksf -o /dev/null "$SCHEME://localhost:$PORT/"; then
  launchctl kickstart -k "gui/$(id -u)/$LABEL" 2>/dev/null || true
fi
for _ in $(seq 1 60); do
  curl -ksf -o /dev/null "$SCHEME://localhost:$PORT/" && break
  sleep 0.5
done
if ! curl -ksf -o /dev/null "$SCHEME://localhost:$PORT/"; then
  alert "ClaudeCall did not start. Details are in ~/Library/Logs/ClaudeCall.log"
  exit 1
fi

# this is the owner's own Mac: the code goes along, so there is nothing to type here. It travels
# after the #, which never leaves the browser, and the page takes it out of the address at once
[ -n "${CLAUDECALL_NO_OPEN:-}" ] && exit 0  # for testing the app without a browser
open "$SCHEME://localhost:$PORT/#code=$(get BUDDY_TOKEN)"

#!/bin/sh
# "ClaudeCall" in the Linux app menu (and the `claudecall` command): make sure the service is up,
# then open the page, already signed in with the access code. install.sh puts it in place.
CONF="$HOME/.config/claudecall"
UNIT=${CLAUDECALL_LABEL:-claudecall}.service
get() { sed -n "s/^$1=//p" "$CONF/env" 2>/dev/null | tail -1 | sed 's/^"\(.*\)"$/\1/'; }
PORT=$(get PORT); PORT=${PORT:-3000}
SCHEME=http
[ "$(get BUDDY_HOST)" = 0.0.0.0 ] && SCHEME=https
up() { curl -ksf -o /dev/null "$SCHEME://localhost:$PORT/"; }

up || systemctl --user start "$UNIT" 2>/dev/null
i=0
while ! up && [ $i -lt 60 ]; do sleep 0.5; i=$((i + 1)); done
if ! up; then
  msg="ClaudeCall did not start. See: journalctl --user -u $UNIT"
  command -v notify-send >/dev/null && notify-send "ClaudeCall" "$msg"
  echo "$msg" >&2
  exit 1
fi
# the code travels after the #, which never leaves the browser; the page drops it at once
[ -n "${CLAUDECALL_NO_OPEN:-}" ] && exit 0
xdg-open "$SCHEME://localhost:$PORT/#code=$(get BUDDY_TOKEN)" >/dev/null 2>&1 &

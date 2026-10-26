#!/bin/sh
# Check a built bundle really runs: start its server with its own Node, wait for speech
# recognition to load (which loads the native onnxruntime and downloads the model), and fetch
# the page. Used by CI after each build.
#
#   scripts/smoke.sh <bundle dir with node/ and app/> [command to run node under, e.g. "arch -x86_64"]
set -eu
DIR=$(cd "$1" && pwd)
RUNNER=${2:-}
PORT=${SMOKE_PORT:-3290}
TMP=$(mktemp -d)
LOG="$TMP/server.log"
cd "$DIR/app"
echo "node $($RUNNER "$DIR/node/bin/node" -v) ($($RUNNER uname -m))"
BUDDY_TOKEN=smoke PORT=$PORT BUDDY_HOME="$TMP/home" BUDDY_DATA="$TMP/data" BUDDY_MODEL_CACHE="$TMP/models" \
  $RUNNER "$DIR/node/bin/node" server/index.ts >"$LOG" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null; wait $PID 2>/dev/null; rm -rf "$TMP"' EXIT
i=0
until grep -qE "Speech recognition ready|failed to load" "$LOG"; do
  i=$((i + 1))
  if [ $i -gt "${SMOKE_TIMEOUT:-300}" ] || ! kill -0 $PID 2>/dev/null; then cat "$LOG"; echo "server did not come up" >&2; exit 1; fi
  sleep 1
done
grep -q "Speech recognition ready" "$LOG" || { cat "$LOG"; echo "speech recognition failed" >&2; exit 1; }
code=$(curl -s -o /dev/null -w "%{http_code}" "http://localhost:$PORT/")
[ "$code" = 200 ] || { cat "$LOG"; echo "page answered $code" >&2; exit 1; }
curl -sf -o /dev/null "http://localhost:$PORT/manifest.webmanifest"
echo "ok: server up, speech recognition loaded, page served"

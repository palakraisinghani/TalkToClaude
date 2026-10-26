#!/bin/sh
# Run ClaudeCall in the background, started at login and restarted if it stops: a launchd agent on
# macOS, a systemd user service on Linux.
#
#   scripts/service.sh install [--lan] [--port N]   set it up and start it
#   scripts/service.sh uninstall                    stop it and remove it
#   scripts/service.sh status | logs | restart
#
# --lan opens it to your network (https with a self-signed certificate), so a phone or tablet on
# the same Wi-Fi can join. Without it, only this computer can — which is also what you want behind
# Tailscale (see README). The settings, including the access code, live in ~/.config/claudecall/env;
# edit that file and run "restart" to change them.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
# the Mac app keeps its own settings (CLAUDECALL_CONF), apart from a copy run from source
CONF=${CLAUDECALL_CONF:-$HOME/.config/claudecall}
ENV_FILE="$CONF/env"
LABEL=${CLAUDECALL_LABEL:-com.claudecall}
UNIT=${CLAUDECALL_LABEL:-claudecall}.service
OS=$(uname -s)

die() { echo "error: $*" >&2; exit 1; }

node_bin() {
  # the Mac app brings its own Node
  if [ -n "${CLAUDECALL_NODE:-}" ]; then echo "$CLAUDECALL_NODE"; return; fi
  command -v node >/dev/null 2>&1 || die "Node.js is not installed (version 23.6 or newer is needed)."
  major=$(node -p 'process.versions.node.split(".")[0]')
  minor=$(node -p 'process.versions.node.split(".")[1]')
  { [ "$major" -gt 23 ] || { [ "$major" -eq 23 ] && [ "$minor" -ge 6 ]; }; } || die "Node.js $(node -v) is too old: 23.6 or newer runs ClaudeCall's TypeScript directly."
  command -v node
}

# the first free port from $1 on, so a copy already running elsewhere is not in the way
free_port() {
  p=$1
  while [ "$p" -lt $(($1 + 20)) ]; do
    # free when nothing answers there (binding to test it can succeed beside a server on 127.0.0.1)
    "$(node_bin)" -e 'const c = require("net").connect(+process.argv[1], "127.0.0.1"); c.once("connect", () => process.exit(1)); c.once("error", () => process.exit(0)); setTimeout(() => process.exit(0), 1500)' "$p" 2>/dev/null && { echo "$p"; return; }
    p=$((p + 1))
  done
  echo "$1"
}

write_env() {
  lan=$1 port=$(free_port "$2")
  mkdir -p "$CONF"
  if [ -f "$ENV_FILE" ]; then
    echo "Keeping your settings in $ENV_FILE"
    # the app's own folders, added to settings made before it was installed
    for v in BUDDY_DATA BUDDY_MODEL_CACHE; do
      val=$(eval "printf %s \"\${$v:-}\"")
      if [ -n "$val" ] && ! grep -q "^$v=" "$ENV_FILE"; then echo "$v=\"$val\"" >>"$ENV_FILE"; fi
    done
    # explicitly: a bare "return" passes on the last test's "false", and under set -e that ended
    # the whole install right here — so updating the app never restarted the service
    return 0
  fi
  # a code that stays the same across restarts, so a phone that has it keeps working
  token=$(od -An -N5 -tx1 /dev/urandom | tr -d ' \n')
  host=127.0.0.1
  [ "$lan" = 1 ] && host=0.0.0.0
  {
    echo "# ClaudeCall settings. Change them, then: scripts/service.sh restart"
    # values are quoted: a folder like "Application Support" has a space in it
    echo "BUDDY_TOKEN=$token"
    echo "BUDDY_HOST=$host"
    echo "PORT=$port"
    echo "BUDDY_HOME=\"${BUDDY_HOME:-$HOME/buddy-home}\""
    echo "CLAUDECALL_CONF=\"$CONF\""
    [ -n "${BUDDY_DATA:-}" ] && echo "BUDDY_DATA=\"$BUDDY_DATA\""
    [ -n "${BUDDY_MODEL_CACHE:-}" ] && echo "BUDDY_MODEL_CACHE=\"$BUDDY_MODEL_CACHE\""
    # the service does not get your shell's PATH: claude, git and node must be findable
    echo "PATH=\"$PATH\""
  } >"$ENV_FILE"
  chmod 600 "$ENV_FILE"
}

get() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -1 | sed 's/^"\(.*\)"$/\1/'; }

show_where() {
  port=$(get PORT); host=$(get BUDDY_HOST)
  echo
  echo "ClaudeCall is running."
  if [ "$host" = 0.0.0.0 ]; then
    ip=$( (ipconfig getifaddr en0 || ipconfig getifaddr en1 || hostname -I | cut -d' ' -f1) 2>/dev/null | head -1)
    echo "  on this computer:   https://localhost:$port"
    [ -n "$ip" ] && echo "  on your phone/iPad: https://$ip:$port   (same Wi-Fi; accept the certificate warning once)"
  else
    echo "  on this computer:   http://localhost:$port"
    echo "  (only this computer can reach it; see README for phones and tablets)"
  fi
  echo "  access code:        $(get BUDDY_TOKEN)"
}

install_mac() {
  node=$1
  plist="$HOME/Library/LaunchAgents/$LABEL.plist"
  mkdir -p "$HOME/Library/LaunchAgents" "$HOME/Library/Logs"
  cat >"$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/bin/sh</string><string>-c</string>
    <string>set -a; . "$ENV_FILE"; set +a; exec "$node" server/index.ts</string>
  </array>
  <key>WorkingDirectory</key><string>$ROOT</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/Library/Logs/ClaudeCall.log</string>
  <key>StandardErrorPath</key><string>$HOME/Library/Logs/ClaudeCall.log</string>
</dict>
</plist>
EOF
  # Stopping finishes in the background: starting the same service again before the old one is
  # gone fails with "Bootstrap failed: 5: Input/output error" — which once left an update with
  # nothing running at all. Wait for the old one to go, then start, trying a few times.
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  for _ in $(seq 1 40); do
    launchctl print "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || break
    sleep 0.25
  done
  for try in 1 2 3 4 5; do
    launchctl bootstrap "gui/$(id -u)" "$plist" 2>/dev/null && return 0
    sleep 1
  done
  launchctl bootstrap "gui/$(id -u)" "$plist" # once more, so its error reaches the log
}

install_linux() {
  node=$1
  command -v systemctl >/dev/null 2>&1 || die "systemd was not found. Run it in a terminal instead: npm start"
  unit="$HOME/.config/systemd/user/$UNIT"
  mkdir -p "$(dirname "$unit")"
  cat >"$unit" <<EOF
[Unit]
Description=ClaudeCall: lead your Claude team by voice
After=network-online.target

[Service]
WorkingDirectory=$ROOT
EnvironmentFile=$ENV_FILE
ExecStart=$node server/index.ts
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
EOF
  systemctl --user daemon-reload
  systemctl --user enable --now "$UNIT"
  echo "Tip: to keep it running while you are logged out: sudo loginctl enable-linger ${USER:-$(id -un)}"
}

cmd=${1:-}
[ $# -gt 0 ] && shift
case "$cmd" in
  install)
    lan=${CLAUDECALL_LAN:-0} port=${CLAUDECALL_PORT:-3000}
    while [ $# -gt 0 ]; do
      case "$1" in
        --lan) lan=1 ;;
        --port) shift; port=${1:?--port needs a number} ;;
        *) die "unknown option: $1" ;;
      esac
      shift
    done
    node=$(node_bin)
    # not fatal: the page walks you through installing and signing in
    command -v claude >/dev/null 2>&1 || echo "Note: Claude Code (the claude command) was not found. ClaudeCall will show you how to install it." 
    [ -d "$ROOT/node_modules" ] || (cd "$ROOT" && npm install)
    write_env "$lan" "$port"
    case "$OS" in
      Darwin) install_mac "$node" ;;
      Linux) install_linux "$node" ;;
      *) die "ClaudeCall runs on macOS and Linux; this is $OS." ;;
    esac
    show_where
    ;;
  uninstall)
    case "$OS" in
      Darwin) launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true; rm -f "$HOME/Library/LaunchAgents/$LABEL.plist" ;;
      Linux) systemctl --user disable --now "$UNIT" 2>/dev/null || true; rm -f "$HOME/.config/systemd/user/$UNIT"; systemctl --user daemon-reload ;;
    esac
    echo "Removed. Your settings stay in $ENV_FILE and your projects in your ClaudeCall home."
    ;;
  restart)
    case "$OS" in
      Darwin) launchctl kickstart -k "gui/$(id -u)/$LABEL" ;;
      Linux) systemctl --user restart "$UNIT" ;;
    esac
    show_where
    ;;
  status)
    case "$OS" in
      Darwin) launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "state|pid =" || echo "not installed" ;;
      Linux) systemctl --user status "$UNIT" --no-pager || true ;;
    esac
    [ -f "$ENV_FILE" ] && show_where
    ;;
  logs)
    case "$OS" in
      Darwin) tail -n 100 -f "$HOME/Library/Logs/ClaudeCall.log" ;;
      Linux) journalctl --user -u "$UNIT" -n 100 -f ;;
    esac
    ;;
  *)
    sed -n '2,12p' "$0" | sed 's/^# \{0,1\}//'
    exit 1
    ;;
esac

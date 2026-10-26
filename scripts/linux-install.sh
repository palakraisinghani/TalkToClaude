#!/bin/sh
# Install ClaudeCall from this folder (the unpacked Linux download). Run: ./install.sh [--lan]
#
# Copies it to ~/.local/share/claudecall, sets it up as a systemd user service (started at login),
# adds ClaudeCall to the app menu and a `claudecall` command, then opens it. Run it again from a
# newer download to update; your settings, projects and access code are kept.
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SHARE="$HOME/.local/share/claudecall"
VERSION=$(cat "$HERE/version")
DEST="$SHARE/$VERSION"

echo "Installing ClaudeCall $VERSION"
mkdir -p "$SHARE"
if [ "$HERE" != "$DEST" ]; then rm -rf "$DEST"; cp -R "$HERE" "$DEST"; fi
ln -sfn "$DEST" "$SHARE/current"

# the service runs this copy's Node, and keeps what it writes outside it
export CLAUDECALL_NODE="$SHARE/current/node/bin/node"
export BUDDY_DATA="$SHARE/data"
export BUDDY_MODEL_CACHE="${XDG_CACHE_HOME:-$HOME/.cache}/claudecall/models"
# a fresh home for the team, its own port
export BUDDY_HOME="$HOME/ClaudeCall"
export CLAUDECALL_PORT=3747
sh "$SHARE/current/app/scripts/service.sh" install "$@"
systemctl --user restart "${CLAUDECALL_LABEL:-claudecall}.service" 2>/dev/null || true

# the app menu and a command
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
install -m 755 "$SHARE/current/launcher.sh" "$HOME/.local/bin/claudecall"
cp "$SHARE/current/app/web/icon-512.png" "$HOME/.local/share/icons/hicolor/512x512/apps/claudecall.png"
cat >"$HOME/.local/share/applications/claudecall.desktop" <<DESKTOP
[Desktop Entry]
Type=Application
Name=ClaudeCall
Comment=Lead your Claude team by voice
Exec=$HOME/.local/bin/claudecall
Icon=claudecall
Terminal=false
Categories=Development;
StartupWMClass=ClaudeCall
DESKTOP
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

# older versions: only the one just installed is kept
for d in "$SHARE"/*/; do
  case "$(basename "$d")" in current | data | "$VERSION") ;; *) rm -rf "$d" ;; esac
done

echo
echo "Done. Open ClaudeCall from your app menu, or run: claudecall"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "(add ~/.local/bin to your PATH for the claudecall command)" ;; esac
[ -n "${CLAUDECALL_NO_OPEN:-}" ] || "$HOME/.local/bin/claudecall" || true

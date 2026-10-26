#!/bin/sh
# Install ClaudeCall from this folder (the unpacked .tar.xz download), for this user only.
#   ./install.sh [--lan]
#
# Copies it to ~/.local/share/claudecall, adds ClaudeCall to the app menu and a `claudecall`
# command, then opens it — which sets it up as your background service (see launcher.sh). Run it
# again from a newer download to update; your settings, projects and access code are kept.
# (On Debian or Ubuntu the .deb does the same with: sudo apt install ./ClaudeCall-….deb)
set -eu
HERE=$(cd "$(dirname "$0")" && pwd)
SHARE="$HOME/.local/share/claudecall"
VERSION=$(cat "$HERE/version")
BUILD=$(cat "$HERE/build" 2>/dev/null || echo "$VERSION")
DEST="$SHARE/$BUILD"

echo "Installing ClaudeCall $VERSION"
mkdir -p "$SHARE"
if [ "$HERE" != "$DEST" ]; then rm -rf "$DEST"; cp -R "$HERE" "$DEST"; fi
ln -sfn "$DEST" "$SHARE/current"

# opening on your network as well, if asked: the setting is written before the first start
if [ "${1:-}" = "--lan" ]; then
  mkdir -p "$HOME/.config/claudecall"
  if [ -f "$HOME/.config/claudecall/env" ]; then
    sed -i 's/^BUDDY_HOST=.*/BUDDY_HOST=0.0.0.0/' "$HOME/.config/claudecall/env"
    printf 'old\n' >"$HOME/.config/claudecall/app-version" # set up again, with the new setting
  else
    export CLAUDECALL_LAN=1
  fi
fi

# the app menu and a command
mkdir -p "$HOME/.local/bin" "$HOME/.local/share/applications" "$HOME/.local/share/icons/hicolor/512x512/apps"
ln -sfn "$SHARE/current/launcher.sh" "$HOME/.local/bin/claudecall"
cp "$SHARE/current/app/web/icon-512.png" "$HOME/.local/share/icons/hicolor/512x512/apps/claudecall.png"
sed "s|^Exec=.*|Exec=$HOME/.local/bin/claudecall|" "$SHARE/current/claudecall.desktop" >"$HOME/.local/share/applications/claudecall.desktop"
command -v update-desktop-database >/dev/null && update-desktop-database "$HOME/.local/share/applications" 2>/dev/null || true

# older copies: only the one just installed is kept
for d in "$SHARE"/*/; do
  case "$(basename "$d")" in current | data | "$BUILD") ;; *) rm -rf "$d" ;; esac
done

echo "Setting up and starting ClaudeCall…"
"$HOME/.local/bin/claudecall"
echo
echo "Done. Open ClaudeCall from your app menu, or run: claudecall"
case ":$PATH:" in *":$HOME/.local/bin:"*) ;; *) echo "(add ~/.local/bin to your PATH for the claudecall command)" ;; esac

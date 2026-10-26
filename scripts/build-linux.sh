#!/bin/sh
# Build the Linux download: a folder with its own Node, the server and page, and install.sh.
#
#   npm run build:linux               for this machine's processor
#   npm run build:linux -- arm64      for arm64 (or x64), from either kind of machine
#
# Writes dist/ClaudeCall-<version>-linux-<arch>.tar.xz. Unpack it and run ./install.sh: it sets
# ClaudeCall up as a systemd user service and adds it to the app menu.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")
ARCH=${1:-$(case "$(uname -m)" in aarch64 | arm64) echo arm64 ;; *) echo x64 ;; esac)}
BUILD="$ROOT/build/linux-$ARCH"
PKG="$BUILD/ClaudeCall"
OUT="$ROOT/dist/ClaudeCall-$VERSION-linux-$ARCH.tar.xz"

echo "Building ClaudeCall $VERSION for Linux $ARCH"
rm -rf "$BUILD" && mkdir -p "$BUILD" "$ROOT/dist"
sh "$ROOT/scripts/bundle.sh" linux "$ARCH" "$PKG"
cp "$ROOT/scripts/linux-install.sh" "$PKG/install.sh"
cp "$ROOT/scripts/linux-launcher.sh" "$PKG/launcher.sh"
chmod +x "$PKG/install.sh" "$PKG/launcher.sh" "$PKG/app/scripts/service.sh"
printf '%s\n' "$VERSION" >"$PKG/version"
cat >"$PKG/README.txt" <<TXT
ClaudeCall $VERSION for Linux ($ARCH)

  ./install.sh          set it up for this computer
  ./install.sh --lan    also for phones and tablets on your Wi-Fi

Needs Claude Code, installed and signed in (ClaudeCall helps with that once it is open).
More: README.md in app/.
TXT
# xz: about a third smaller than gzip here, and every current Linux unpacks it
XZ_OPT=-9 tar -cJf "$OUT" -C "$BUILD" ClaudeCall
echo
echo "Built $OUT ($(du -h "$OUT" | awk '{print $1}'))"

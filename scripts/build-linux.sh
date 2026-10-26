#!/bin/sh
# Build the Linux downloads: a .deb (Debian, Ubuntu) and a .tar.xz (any distribution), each with
# its own Node, the server and the page.
#
#   npm run build:linux               for this machine's processor
#   npm run build:linux -- arm64      for arm64 (or x64), from either kind of machine
#
# Writes dist/ClaudeCall-<version>-linux-<arch>.deb  (sudo apt install ./that.deb)
#    and dist/ClaudeCall-<version>-linux-<arch>.tar.xz (unpack, then ./install.sh)
# Either way, opening ClaudeCall sets it up as the user's systemd service (linux-launcher.sh).
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
cp "$ROOT/scripts/claudecall.desktop" "$PKG/claudecall.desktop"
chmod +x "$PKG/install.sh" "$PKG/launcher.sh" "$PKG/app/scripts/service.sh"
printf '%s\n' "$VERSION" >"$PKG/version"
# which build: an update restarts each user's service onto it (launcher.sh checks)
STAMP=$(date +%s)
printf '%s\n' "$VERSION-$(cd "$ROOT" && git rev-parse --short HEAD 2>/dev/null)-$STAMP" >"$PKG/build"
cat >"$PKG/README.txt" <<TXT
ClaudeCall $VERSION for Linux ($ARCH)

  ./install.sh          set it up for this computer
  ./install.sh --lan    also for phones and tablets on your Wi-Fi

Needs Claude Code, installed and signed in (ClaudeCall helps with that once it is open).
More: README.md in app/.
TXT
# xz: about a third smaller than gzip here, and every current Linux unpacks it
# plain ustar, and on a Mac none of its own file labels (GNU tar has no such options, nor needs them)
TARFLAGS="--format ustar"
tar --version 2>/dev/null | grep -q bsdtar && TARFLAGS="$TARFLAGS --no-xattrs --no-mac-metadata"
# shellcheck disable=SC2086
COPYFILE_DISABLE=1 XZ_OPT=-9 tar $TARFLAGS -cJf "$OUT" -C "$BUILD" ClaudeCall
DEB="$ROOT/dist/ClaudeCall-$VERSION-linux-$ARCH.deb"
# 0.1.0+<build time>: every build sorts after the one before, so apt upgrades even within a
# version (it once refused: "claudecall is already the newest version")
node "$ROOT/scripts/make-deb.mjs" "$PKG" "$ARCH" "$VERSION+$STAMP" "$DEB"
echo
echo "Built $OUT ($(du -h "$OUT" | awk '{print $1}'))"
echo "Built $DEB ($(du -h "$DEB" | awk '{print $1}'))"

#!/bin/sh
# Lay out a self-contained ClaudeCall for one platform: the app's files, an official Node for that
# platform (checked against its published checksum), and the dependencies for that platform.
#
#   scripts/bundle.sh <darwin|linux> <arm64|x64> <dest>
#
# Used by build-mac.sh and build-linux.sh. It can build for another processor than the one it
# runs on (the dependencies are chosen with npm's --os/--cpu, nothing is compiled), so one Mac
# makes both Mac builds and one Linux machine both Linux builds. Leaves:
#   <dest>/app         the server, page and prompts, with node_modules
#   <dest>/node/bin/node
set -eu

OS=$1 ARCH=$2 DEST=$3
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NODE_LINE=${NODE_LINE:-latest-v24.x}  # an LTS line new enough to run TypeScript directly
case "$OS-$ARCH" in darwin-arm64 | darwin-x64 | linux-arm64 | linux-x64) ;; *) echo "unsupported: $OS $ARCH" >&2; exit 1 ;; esac

rm -rf "$DEST" && mkdir -p "$DEST/app" "$DEST/node/bin"

# ---------- the app's own files, as tracked in git ----------
(cd "$ROOT" && git ls-files -co --exclude-standard -- server web skill scripts package.json package-lock.json README.md \
  | grep -vE '\.test\.(ts|js)$|^scripts/(build-|bundle|eval-|make-icons)' | tar -cf - -T -) | tar -xf - -C "$DEST/app"

# ---------- Node for that platform ----------
DL=$(mktemp -d)
SUMS=$(curl -fsSL "https://nodejs.org/dist/$NODE_LINE/SHASUMS256.txt")
TARBALL=$(printf '%s\n' "$SUMS" | awk '{print $2}' | grep -E "^node-v[0-9.]+-$OS-$ARCH\.tar\.gz$")
EXPECT=$(printf '%s\n' "$SUMS" | awk -v f="$TARBALL" '$2 == f {print $1}')
echo "Node: $TARBALL"
curl -fsSL -o "$DL/$TARBALL" "https://nodejs.org/dist/$NODE_LINE/$TARBALL"
GOT=$( (command -v sha256sum >/dev/null && sha256sum "$DL/$TARBALL" || shasum -a 256 "$DL/$TARBALL") | awk '{print $1}')
[ "$GOT" = "$EXPECT" ] || { echo "Node download does not match its checksum." >&2; exit 1; }
tar -xzf "$DL/$TARBALL" -C "$DL"
cp "$DL/${TARBALL%.tar.gz}/bin/node" "$DEST/node/bin/node"
cp "$DL/${TARBALL%.tar.gz}/LICENSE" "$DEST/node/LICENSE"
rm -rf "$DL"

# ---------- dependencies for that platform, trimmed of what it never loads ----------
LIBC=$([ "$OS" = linux ] && echo "--libc=glibc" || echo "")
# shellcheck disable=SC2086
(cd "$DEST/app" && npm ci --omit=dev --os="$OS" --cpu="$ARCH" $LIBC --no-audit --no-fund --loglevel=error)
NM="$DEST/app/node_modules"
rm -rf "$NM/@huggingface/transformers/.cache"
for d in "$NM"/onnxruntime-node/bin/napi-v*/*; do [ "$(basename "$d")" = "$OS" ] || rm -rf "$d"; done
for d in "$NM"/onnxruntime-node/bin/napi-v*/"$OS"/*; do [ "$(basename "$d")" = "$ARCH" ] || rm -rf "$d"; done
# sharp's prebuilt binaries: only this platform's
for d in "$NM"/@img/sharp-*; do
  case "$(basename "$d")" in *-"$OS"-"$ARCH" | sharp-libvips-"$OS"-"$ARCH") ;; *) rm -rf "$d" ;; esac
done
find "$NM" -name "*.map" -type f -delete
ls "$NM"/@img >/dev/null 2>&1 && [ -n "$(ls "$NM"/@img | grep -E "^sharp-$OS-$ARCH$")" ] || { echo "sharp for $OS-$ARCH is missing" >&2; exit 1; }
[ -d "$NM/onnxruntime-node/bin/napi-v6/$OS/$ARCH" ] || { echo "onnxruntime for $OS-$ARCH is missing" >&2; exit 1; }
echo "Bundled $OS-$ARCH: $(du -sh "$DEST" | awk '{print $1}')"

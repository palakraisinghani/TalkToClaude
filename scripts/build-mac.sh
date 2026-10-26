#!/bin/sh
# Build ClaudeCall.app and a .dmg to install it from. Run on a Mac: npm run build:mac
#
# The app carries everything it needs except Claude Code itself: its own Node, the server, the page
# and the speech recogniser's code (the model is downloaded on first start). Opening it
# starts ClaudeCall as a background service (the same one `npm run service install` sets up), then
# opens it in the browser, where it can be installed as an app and where the setup check helps with
# Claude Code.
#
#   npm run build:mac
#
# Apple silicon only: the speech recogniser's runtime (onnxruntime-node) no longer ships for Intel
# Macs, and macOS 26 is the last release for them anyway.
#
# It is signed ad hoc, not with an Apple Developer ID, so the first time macOS will say it cannot
# check it: right-click the app and choose Open, or allow it in System Settings → Privacy & Security.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
VERSION=$(node -p 'require(process.argv[1]).version' "$ROOT/package.json")
ARCH=${1:-arm64}
[ "$ARCH" = arm64 ] || { echo "The Mac app is for Apple silicon only: onnxruntime-node, which hears you, has no Intel Mac build." >&2; exit 1; }
BUILD="$ROOT/build/mac-$ARCH"
APP="$BUILD/ClaudeCall.app"
OUT="$ROOT/dist/ClaudeCall-$VERSION-mac-apple-silicon.dmg"

[ "$(uname -s)" = Darwin ] || { echo "Build the Mac app on a Mac." >&2; exit 1; }
echo "Building ClaudeCall $VERSION for macOS $ARCH"
rm -rf "$BUILD" && mkdir -p "$APP/Contents/MacOS" "$ROOT/dist"
RES="$APP/Contents/Resources"
sh "$ROOT/scripts/bundle.sh" darwin "$ARCH" "$RES"

# ---------- icon, made with this machine's own copy of sharp (npm ci first) ----------
ICONSET="$BUILD/AppIcon.iconset"
mkdir -p "$ICONSET"
(cd "$ROOT" && node --input-type=module -e '
  const [, src, dir] = process.argv;
  const sharp = (await import("sharp")).default;
  for (const s of [16, 32, 128, 256, 512]) {
    await sharp(src, { density: 72 * (s * 2) / 64 }).resize(s, s).png().toFile(`${dir}/icon_${s}x${s}.png`);
    await sharp(src, { density: 72 * (s * 4) / 64 }).resize(s * 2, s * 2).png().toFile(`${dir}/icon_${s}x${s}@2x.png`);
  }' "$ROOT/web/icon.svg" "$ICONSET")
iconutil -c icns "$ICONSET" -o "$RES/AppIcon.icns"

# ---------- Info.plist and the launcher ----------
cat >"$APP/Contents/Info.plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key><string>ClaudeCall</string>
  <key>CFBundleDisplayName</key><string>ClaudeCall</string>
  <key>CFBundleIdentifier</key><string>com.claudecall.app</string>
  <key>CFBundleVersion</key><string>$VERSION</string>
  <key>CFBundleShortVersionString</key><string>$VERSION</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleExecutable</key><string>ClaudeCall</string>
  <key>CFBundleIconFile</key><string>AppIcon</string>
  <key>LSMinimumSystemVersion</key><string>12.0</string>
  <key>NSHighResolutionCapable</key><true/>
</dict>
</plist>
EOF
cp "$ROOT/scripts/mac-launcher.sh" "$APP/Contents/MacOS/ClaudeCall"
chmod +x "$APP/Contents/MacOS/ClaudeCall" "$RES/app/scripts/service.sh"
printf '%s\n' "$VERSION" >"$RES/version"

# ---------- sign (ad hoc) and package ----------
codesign --force --deep --sign - "$APP" 2>&1 | grep -v "replacing existing signature" || true
codesign --verify --deep "$APP"
STAGE="$BUILD/dmg"
mkdir -p "$STAGE"
cp -R "$APP" "$STAGE/"
ln -s /Applications "$STAGE/Applications"
rm -f "$OUT"
# newer macOS has diskutil image (hdiutil create is deprecated there); hdiutil is known to fail
# now and then with "Resource busy" while Spotlight looks at the new folder, so it gets retries
# a failed attempt can leave the half-made image attached: let it go before the next try
let_go() {
  hdiutil info | awk -v img="$OUT" '$1 == "image-path" { on = ($3 == img) } on && /^\/dev\/disk[0-9]+\t/ { print $1 }' \
    | while read -r dev; do hdiutil detach "$dev" -force >/dev/null 2>&1 || true; done
  rm -f "$OUT"
}
made=0
if diskutil image create from --help >/dev/null 2>&1; then
  diskutil image create from --format UDZO --volumeName ClaudeCall "$STAGE" "$OUT" >/dev/null 2>&1 && made=1 || let_go
fi
for try in 1 2 3 4 5; do
  [ "$made" = 1 ] && break
  hdiutil create -quiet -volname ClaudeCall -srcfolder "$STAGE" -ov -format UDZO "$OUT" 2>/dev/null && made=1 && break
  let_go
  sleep 3
done
[ "$made" = 1 ] || { echo "Could not make the disk image." >&2; exit 1; }
echo
echo "Built $OUT ($(du -h "$OUT" | awk '{print $1}'))"

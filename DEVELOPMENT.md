# Developing ClaudeCall

For installing the app, see [README.md](README.md). This covers running it from source, building
the downloads and releasing.

## Run from source

Needs Node.js 23.6 or newer (it runs the TypeScript directly), Claude Code signed in, and git.

```sh
npm install
npm start
```

Open http://localhost:3000 and enter the access code printed in the terminal. A copy run from
source uses `~/buddy-home` for its projects; the installed app uses `~/ClaudeCall` and port 3747,
so the two never get in each other's way.

```sh
npm test
node scripts/eval-names.ts --stt=accurate   # how well names are heard (macOS)
npm run icons                               # remake the app icons from web/icon.svg
```

## Keep a source copy running

```sh
npm run service install          # this computer only
npm run service install -- --lan # also phones and tablets on your Wi-Fi
```

Settings are in `~/.config/claudecall/env`; after changing them, run `npm run service restart`.
Also: `npm run service status`, `logs`, `uninstall`. It's a launchd agent on macOS and a systemd
user service on Linux.

## Building the downloads

```sh
npm run build:mac                 # dist/ClaudeCall-<v>-mac-apple-silicon.dmg (on a Mac)
npm run build:linux -- x64        # dist/ClaudeCall-<v>-linux-x64.deb and .tar.xz (on a Mac or Linux)
npm run build:linux -- arm64
```

- `scripts/bundle.sh` lays out a self-contained copy for one platform. That means:
  - an official Node, checked against its published checksum
  - dependencies chosen with npm's `--os`/`--cpu`, so either processor can be built from either
  - trimmed by `scripts/prune.mjs` to what the server imports and the page loads
- `scripts/build-mac.sh` builds `ClaudeCall.app`:
  - a native window, `mac/main.swift`
  - the launcher, `scripts/mac-launcher.sh`, which sets up the service and checks the running build
  - the DMG, with an ad-hoc signature
- `scripts/build-linux.sh` builds the `.tar.xz` and, through `scripts/make-deb.mjs`, the `.deb`.
  - The `.deb` uses `dpkg-deb` when it's there; on a Mac the same archive is written directly.
  - The `.deb` version is `<version>+<build time>`, so every build upgrades the one before.
  - `scripts/linux-launcher.sh` sets up each user's systemd service the first time it's opened, and
    again after an update.
- `scripts/smoke.sh <bundle>` starts a built copy, waits for speech recognition, and fetches the page.

Each build writes a stamp (`build`). The server reports it at `/version`, and the launchers restart
the service if the running build isn't theirs. The page reloads when it changes.

## Releasing

GitHub Actions (`.github/workflows/build.yml`) runs on every push to `main` and every pull
request:
- the tests
- the DMG, and each one checked to start
- both `.deb` files, each installed with apt and started
- both `.tar.xz` files
- the Android APK

To publish a release, push a version tag:

```sh
git tag v0.2.0 && git push origin v0.2.0
```

**Android release key (optional).** Without one, each APK is signed with a throwaway key, so a newer
version won't install over an older one. To fix that, make a key once and keep it safe:

```sh
keytool -genkeypair -v -keystore claudecall.jks -alias claudecall -keyalg RSA -keysize 4096 -validity 10000
base64 -i claudecall.jks | pbcopy      # on Linux: base64 -w0 claudecall.jks
```

Then add `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`
(`claudecall`) and `ANDROID_KEY_PASSWORD` under Settings → Secrets and variables → Actions.

**Mac signing.** The DMG is signed ad hoc, so first-time users have to right-click → Open. Signing
and notarising it needs an Apple Developer ID.

## Settings

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` (app: `3747`) | |
| `BUDDY_HOST` | `127.0.0.1` | `0.0.0.0` opens it to your network (and turns on https) |
| `BUDDY_TOKEN` | random each start (service: kept) | the access code |
| `BUDDY_HOME` | `~/buddy-home` (app: `~/ClaudeCall`) | Ada's folder; new projects are made in it |
| `BUDDY_STT_MODEL` | `fast` | `accurate` for a larger, slower recogniser |
| `BUDDY_DATA` | the source folder | where calls, logs and the certificate are written |
| `BUDDY_MODEL_CACHE` | inside `node_modules` | where the speech models are kept |
| `ANTHROPIC_API_KEY` | | used by the agents instead of a Claude sign-in |

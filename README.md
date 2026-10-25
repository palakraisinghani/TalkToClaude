# ClaudeCall

Lead your Claude team by voice. You talk; Ada, your assistant, sets up projects and keeps track of
who needs you; each project has its own Claude Code agent working in its own folder. One agent has
the floor at a time, and the others keep working in the background.

ClaudeCall runs on your own computer (macOS or Linux). You use it from a browser on that computer,
or from your phone or iPad. On any of them it can be installed as an app.

## What you need

- **macOS or Linux**
- **Claude Code**, installed and signed in on that computer. Every agent is a Claude Code session.
  ```sh
  curl -fsSL https://claude.ai/install.sh | bash    # or: npm install -g @anthropic-ai/claude-code
  claude auth login                                 # a Claude subscription; --console for API billing
  ```
  You don't have to do this first. After you connect, ClaudeCall checks for Claude Code. If it's
  missing or signed out, it shows these steps. On the computer itself, a button opens Claude Code's
  own sign-in. ClaudeCall never sees your password or token. You can also paste an Anthropic API
  key there instead. It is kept in `~/.config/claudecall/anthropic-key`, readable only by you.
- **git** (for undo)
- On Linux, optionally **zenity** for the "Choose folder" button
- To run from source: **Node.js 23.6 or newer** (the Mac app brings its own)

## Mac app

Download `ClaudeCall-<version>-<arch>.dmg`, open it, and drag ClaudeCall to Applications. Opening
the app does two things:
- starts ClaudeCall in the background, and keeps it running after login
- opens it in your browser, already signed in with the access code, and ready to install as an app

The first start downloads the speech model, which takes about a minute. Its data goes in
`~/Library/Application Support/ClaudeCall`, and the speech model in `~/Library/Caches/ClaudeCall`.

The app is not signed with an Apple Developer ID yet. The first time, right-click it and choose
**Open**, or allow it in System Settings → Privacy & Security.

To build it yourself on a Mac: `npm run build:mac` (it writes `dist/ClaudeCall-<version>-<arch>.dmg`,
for the Mac it's built on).

## Run from source

```sh
npm install
npm start
```

Open http://localhost:3000 and enter the access code printed in the terminal. The first start
downloads the speech recogniser model. After that it runs offline, apart from Claude itself.

## Keep it running

To start ClaudeCall at login and restart it if it stops:

```sh
npm run service install          # this computer only
npm run service install -- --lan # also phones and tablets on your Wi-Fi
```

It prints the address and an access code that stays the same. Settings are in
`~/.config/claudecall/env`; after changing them, run `npm run service restart`. Other commands:
`npm run service status`, `logs`, `uninstall`.

It runs as a launchd agent on macOS (log: `~/Library/Logs/ClaudeCall.log`) and a systemd user
service on Linux (`journalctl --user -u claudecall`).

## On your phone or iPad

Browsers only allow the microphone over https, so a phone needs a secure address. There are two
ways to get one.

**Tailscale (recommended).** This gives you a real certificate, and it works away from home too.
Install [Tailscale](https://tailscale.com) on the computer and on the phone, then on the computer:

```sh
npm run service install          # ClaudeCall itself stays private to this computer
tailscale serve --bg 3000
```

Open the `https://<computer>.<tailnet>.ts.net` address it prints on your phone.

**Same Wi-Fi.** With `--lan`, ClaudeCall serves https on your network, using a certificate it made
itself. Open the `https://<ip>:3000` address it prints and accept the warning once. If your computer's address changes, delete the `certs/`
folder and restart, so a new certificate is made.

Either way, enter the access code once on each device.

## Install it as an app

- **iPhone / iPad (Safari):** Share → Add to Home Screen
- **Android (Chrome):** ⋮ → Install app
- **Mac:** Safari → File → Add to Dock, or Chrome / Edge → Install ClaudeCall
- **Linux (Chrome / Edge / Chromium):** the install icon in the address bar

It opens full screen with its own icon. The layout fits a phone (one section at a time, with tabs at
the bottom), a tablet either way up, and a laptop.

## macOS and Linux differences

Everything works on both, except two features that use macOS's own voices:

- **Stereo voices** (each agent speaking from its own side)
- **"Test how it's heard"** for a new agent's name

On Linux the browser speaks instead, and those two options are hidden.

## Settings

| Variable | Default | |
|---|---|---|
| `PORT` | `3000` | |
| `BUDDY_HOST` | `127.0.0.1` | `0.0.0.0` opens it to your network (and turns on https) |
| `BUDDY_TOKEN` | random each start | the access code |
| `BUDDY_HOME` | `~/buddy-home` | Ada's folder; new projects are made in it |
| `BUDDY_STT_MODEL` | `fast` | `accurate` for a larger, slower recogniser |
| `BUDDY_DATA` | the app folder | where calls, logs and the certificate are written |
| `BUDDY_MODEL_CACHE` | inside `node_modules` | where the speech models are kept |
| `ANTHROPIC_API_KEY` | | used by the agents instead of a Claude sign-in |

## Development

```sh
npm test
node scripts/eval-names.ts --stt=accurate   # how well names are heard (macOS)
npm run icons                               # remake the app icons from web/icon.svg
```

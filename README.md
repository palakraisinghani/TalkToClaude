# ClaudeCall

**Lead your Claude team by voice.** You talk; Ada, your assistant, sets up projects, hands out
the work and tells you who needs you. Each project gets its own Claude Code agent, working in its
own folder on your computer. One agent has the floor at a time, and the rest keep working in the
background.

This guide is for installing the app. To build it or work on it, see [DEVELOPMENT.md](DEVELOPMENT.md).

---

## Before you start: Claude Code

Every agent in ClaudeCall is a [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)
session, so the computer you install ClaudeCall on needs Claude Code installed and signed in. In a
terminal:

```sh
curl -fsSL https://claude.ai/install.sh | bash
claude auth login
```

`claude auth login` signs in with a Claude subscription. For API billing, use
`claude auth login --console`.

Not done yet? That's fine. When you open ClaudeCall it checks, and shows you these steps with a
button that opens the sign-in. You can also paste an Anthropic API key there instead.

You also need **git**; ClaudeCall uses it to undo an agent's changes. Macs have it once the developer
tools are installed (`xcode-select --install`). On Linux, the `.deb` installs it for you.

---

## Download

Get the latest version from the
**[Releases page](https://github.com/palakraisinghani/TalkToClaude/releases)**:

| Your computer | Download |
|---|---|
| Mac with Apple silicon (M1 or later) | `ClaudeCall-<version>-mac-apple-silicon.dmg` |
| Ubuntu / Debian on Intel or AMD | `ClaudeCall-<version>-linux-x64.deb` |
| Ubuntu / Debian on ARM | `ClaudeCall-<version>-linux-arm64.deb` |
| Other Linux | `ClaudeCall-<version>-linux-x64.tar.xz` or `-arm64.tar.xz` |

Not sure which Linux one? Run `uname -m` in a terminal. `x86_64` means x64; `aarch64` means arm64.

Intel Macs aren't supported, because the speech recogniser no longer runs on them.

---

## Install on a Mac

1. Open the `.dmg` and drag **ClaudeCall** onto **Applications**.
2. Open ClaudeCall from Applications or Spotlight.
   - The first time, macOS may say it can't check the app, because it isn't signed with an Apple
     developer ID yet. Right-click ClaudeCall and choose **Open**, or go to System Settings →
     Privacy & Security and click **Open Anyway**.
   - If you open it straight from the disk image, it offers to copy itself to Applications. Say yes.
3. ClaudeCall opens in its own window, already signed in. The first start takes about a minute
   while the speech recogniser downloads.
4. Press the call button (the phone, in the middle). Allow the microphone when macOS asks.

ClaudeCall runs in the background from then on and starts when you log in. Closing the window
doesn't stop your team: agents keep working, and you can open the window again any time.

## Install on Ubuntu or Debian

```sh
sudo apt install ./ClaudeCall-<version>-linux-x64.deb      # or …-linux-arm64.deb
```

Then open **ClaudeCall** from your app menu, or run `claudecall` in a terminal.

- The first time, it sets itself up as your background service; that takes a few seconds. The first
  call takes about a minute longer while the speech recogniser downloads.
- It opens in a window of its own if Chrome, Chromium, Edge or Brave is installed. Otherwise it
  opens in your browser.
- Each person on the computer gets their own ClaudeCall, with their own projects.

Ubuntu 20.04 or newer and Debian 10 or newer work.

## Install on other Linux

```sh
tar -xf ClaudeCall-<version>-linux-x64.tar.xz
cd ClaudeCall
./install.sh
```

This installs ClaudeCall for your user in `~/.local/share/claudecall`. It also adds it to your app
menu and adds a `claudecall` command. It needs systemd (most distributions have it).

---

## Using it

Press the call button (the phone) and talk. Some things to try:

- **"Ada, start a project for a recipe website. Call the agent Kiwi."** Ada creates the folder,
  briefs Kiwi, and Kiwi starts working in the background.
- **Say an agent's name** ("Kiwi") to talk to it. Say **"Ada"** to come back to her.
- **"What's waiting for me?"** reads out who needs your yes or an answer.
- **"Plan mode"** makes the agent plan first and wait for your approval. **"Auto mode"** goes
  back to normal.
- **"Think harder"**, **"new conversation"**, **"compact"**, **"undo"**, **"stop Kiwi"**.
- **"Bye"** ends the call. Your team keeps working.

You can talk over anyone at any time; nothing they started is lost. You can also type instead of
speaking. Typing `/` in the box shows commands like `/plan`, `/model opus`, `/effort high` and
`/clear`.

Agents ask before doing anything risky. Say **"yes"** or **"no"**. For something that can't be undone,
like removing an agent from the team, say **"confirm"**.

**Settings** (the sliders icon, top right) has:
- **Voices:** each agent's voice, speed and side.
- **How you speak:** your accent, so names are heard the way you say them.
- **Teach names:** say a few names a few times so they're recognised by your voice.
- **Models:** which Claude model each agent uses.
- **Phones and tablets:** the address and access code for joining from another device.

Where things live:
- **Projects:** in `~/ClaudeCall`, one folder each.
- **The app's own data:** `~/Library/Application Support/ClaudeCall` (Mac) or
  `~/.config/claudecall` (Linux).

---

## From your phone or tablet

ClaudeCall runs on your computer, and your phone joins it. Browsers only allow the microphone over a
secure (https) address, so pick one of these.

**Tailscale (recommended, works anywhere).** Install [Tailscale](https://tailscale.com) on the
computer and the phone, then on the computer run:

```sh
tailscale serve --bg 3747
```

Open the `https://<computer>.<tailnet>.ts.net` address it prints on your phone.

**Same Wi-Fi.**
1. Open ClaudeCall's settings file:
   - Mac: `~/Library/Application Support/ClaudeCall/env`
   - Linux: `~/.config/claudecall/env`
2. Change `BUDDY_HOST=127.0.0.1` to `BUDDY_HOST=0.0.0.0`.
3. Restart ClaudeCall:
   - Mac: `launchctl kickstart -k gui/$(id -u)/com.claudecall`
   - Linux: `systemctl --user restart claudecall`
4. On the computer, open **Settings → Phones and tablets** to see the address.
5. Open that address on your phone and accept the certificate warning once.

Either way, enter the access code once. It's shown in **Settings → Phones and tablets** and in the
settings file (`BUDDY_TOKEN`).

To use it as an app on your phone:
- **iPhone or iPad:** in Safari, Share → **Add to Home Screen**.
- **Android:** in Chrome, ⋮ → **Install app**, or install `ClaudeCall-<version>-android.apk`.

---

## Updating

- **Mac:** download the new `.dmg` and drag ClaudeCall over the old one, even while it's open.
  It restarts itself as the new version.
- **Ubuntu / Debian:** `sudo apt install ./ClaudeCall-<new version>-linux-x64.deb`. Anyone already
  running ClaudeCall is moved onto the new version.
- **Other Linux:** run `./install.sh` from the new download.

Your projects, settings, learned names and access code are kept.

---

## Uninstalling

**Mac:**
```sh
launchctl bootout gui/$(id -u)/com.claudecall
rm ~/Library/LaunchAgents/com.claudecall.plist
```
Then move ClaudeCall from Applications to the Trash. To remove its data too, delete:
- `~/Library/Application Support/ClaudeCall`
- `~/Library/Caches/ClaudeCall`

Your projects in `~/ClaudeCall` stay unless you delete them.

**Ubuntu / Debian:**
```sh
sudo apt remove claudecall
systemctl --user disable claudecall
rm ~/.config/systemd/user/claudecall.service
```
Its data is in `~/.config/claudecall`, `~/.local/share/claudecall` and `~/.cache/claudecall`. Your
projects are in `~/ClaudeCall`.

---

## If something's not right

- **"Almost there: Claude Code installed / Signed in"** means ClaudeCall can't find Claude Code or
  you're not signed in. Follow the steps on that screen, then click **Check again**.
- **It doesn't hear you.** Check that the microphone is allowed:
  - Mac: System Settings → Privacy & Security → Microphone → ClaudeCall.
  - Browser: the site's microphone permission.
- **It hears itself through the speakers.** Turn on **Bluetooth** at the top (meaning you're on
  headphones). Then you can cut in instantly, and it won't mistake its own voice for yours.
- **A name keeps being misheard.** Settings → Teach names. Or pick a clearer name; the dialog for a
  new agent rates how easy a name is to hear.
- **Logs:**
  - Mac: `~/Library/Logs/ClaudeCall.log` (or View → Show Log in the app) and
    `~/Library/Logs/ClaudeCall-launcher.log`.
  - Linux: `journalctl --user -u claudecall` and `~/.config/claudecall/launcher.log`.
- **Mac voices vs Linux:** on a Mac, each agent speaks in its own Mac voice from its own side. On
  Linux the browser's voices are used instead.

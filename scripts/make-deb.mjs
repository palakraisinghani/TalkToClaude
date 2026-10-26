// Package a bundled Linux ClaudeCall (from scripts/bundle.sh) as a .deb, for Debian and Ubuntu.
//   node scripts/make-deb.mjs <bundle dir> <x64|arm64> <version> <out.deb>
//
// Installs into /opt/claudecall, with `claudecall` on the PATH, an app-menu entry and its icon.
// Nothing is set up system-wide beyond that: each user's ClaudeCall runs as their own background
// service, which the launcher sets up the first time they open it (scripts/linux-launcher.sh).
//
// On Linux, dpkg-deb builds it. Elsewhere (a Mac) the same archive is written directly: a .deb is
// an "ar" archive of three members — debian-binary, control.tar.gz, data.tar.xz.

import { execFileSync } from "node:child_process";
import { chmodSync, copyFileSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

const [bundle, arch, version, out] = process.argv.slice(2);
if (!out) throw new Error("usage: node scripts/make-deb.mjs <bundle dir> <x64|arm64> <version> <out.deb>");
const debArch = { x64: "amd64", arm64: "arm64" }[arch];
if (!debArch) throw new Error(`unknown arch ${arch}`);
const scripts = new URL(".", import.meta.url).pathname;
const work = mkdtempSync(join(tmpdir(), "cc-deb-"));
const root = join(work, "root");
const ctrl = join(work, "DEBIAN");

// ---------- the files ----------
mkdirSync(join(root, "opt"), { recursive: true });
cpSync(bundle, join(root, "opt", "claudecall"), { recursive: true, verbatimSymlinks: true });
rmSync(join(root, "opt", "claudecall", "install.sh"), { force: true }); // the .tar.xz's own installer
mkdirSync(join(root, "usr", "bin"), { recursive: true });
symlinkSync("/opt/claudecall/launcher.sh", join(root, "usr", "bin", "claudecall"));
mkdirSync(join(root, "usr", "share", "applications"), { recursive: true });
copyFileSync(join(scripts, "claudecall.desktop"), join(root, "usr", "share", "applications", "claudecall.desktop"));
for (const size of [192, 512]) {
  const dir = join(root, "usr", "share", "icons", "hicolor", `${size}x${size}`, "apps");
  mkdirSync(dir, { recursive: true });
  copyFileSync(join(bundle, "app", "web", `icon-${size}.png`), join(dir, "claudecall.png"));
}
const installedKb = Number(execFileSync("du", ["-sk", root]).toString().split(/\s/)[0]);

// ---------- what dpkg needs to know ----------
mkdirSync(ctrl);
writeFileSync(join(ctrl, "control"), `Package: claudecall
Version: ${version}
Architecture: ${debArch}
Maintainer: ClaudeCall <noreply@claudecall.app>
Installed-Size: ${installedKb}
Depends: libc6 (>= 2.28), libstdc++6, curl, git
Recommends: xdg-utils, libnotify-bin, zenity
Section: devel
Priority: optional
Homepage: https://github.com/palakraisinghani/TalkToClaude
Description: Lead your Claude team by voice
 ClaudeCall is a voice call with your Claude Code agents: you talk, Ada your
 assistant sets up projects and hands out the work, and each project's agent
 works in its own folder. Needs Claude Code, installed and signed in.
`);
// After an install or an update: the menu picks up the entry, and anyone already running
// ClaudeCall is moved onto the new files (theirs were just replaced underneath it).
writeFileSync(join(ctrl, "postinst"), `#!/bin/sh
set -e
command -v update-desktop-database >/dev/null 2>&1 && update-desktop-database -q /usr/share/applications || true
command -v gtk-update-icon-cache >/dev/null 2>&1 && gtk-update-icon-cache -q -t /usr/share/icons/hicolor || true
for unit in /home/*/.config/systemd/user/claudecall.service /root/.config/systemd/user/claudecall.service; do
  [ -f "$unit" ] || continue
  user=$(stat -c %U "$unit"); uid=$(id -u "$user" 2>/dev/null) || continue
  [ -d "/run/user/$uid" ] || continue
  runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user try-restart claudecall.service >/dev/null 2>&1 || true
done
echo "ClaudeCall is installed. Open it from your app menu, or run: claudecall"
exit 0
`);
// Removed: stop any running copies (their files are gone); each user's settings and projects stay.
writeFileSync(join(ctrl, "prerm"), `#!/bin/sh
set -e
if [ "$1" = remove ]; then
  for unit in /home/*/.config/systemd/user/claudecall.service /root/.config/systemd/user/claudecall.service; do
    [ -f "$unit" ] || continue
    user=$(stat -c %U "$unit"); uid=$(id -u "$user" 2>/dev/null) || continue
    [ -d "/run/user/$uid" ] || continue
    runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" systemctl --user stop claudecall.service >/dev/null 2>&1 || true
  done
fi
exit 0
`);
for (const f of ["postinst", "prerm"]) chmodSync(join(ctrl, f), 0o755);

// ---------- build it ----------
const has = (cmd) => { try { execFileSync("sh", ["-c", `command -v ${cmd}`], { stdio: "ignore" }); return true; } catch { return false; } };
if (has("dpkg-deb")) {
  cpSync(ctrl, join(root, "DEBIAN"), { recursive: true });
  execFileSync("dpkg-deb", ["--root-owner-group", "-Zxz", "--build", root, out], { stdio: "inherit" });
} else {
  // every file owned by root, no Mac metadata, paths as "./opt/…" the way dpkg writes them
  const env = { ...process.env, COPYFILE_DISABLE: "1" };
  // plain ustar: macOS's tar otherwise adds pax headers (LIBARCHIVE.creationtime) that dpkg's
  // own extractor cannot read — the install fails with "paste subprocess was killed"
  const tarArgs = ["--format", "ustar", "--uid", "0", "--gid", "0", "--uname", "root", "--gname", "root", "--no-xattrs", "--no-mac-metadata"];
  execFileSync("tar", [...tarArgs, "-czf", join(work, "control.tar.gz"), "-C", ctrl, "./control", "./postinst", "./prerm"], { env });
  execFileSync("tar", [...tarArgs, "-cJf", join(work, "data.tar.xz"), "-C", root, "./opt", "./usr"], { env });
  writeFileSync(join(work, "debian-binary"), "2.0\n");
  // the ar archive: a global header, then each member with its 60-byte header, padded to even
  const parts = [Buffer.from("!<arch>\n")];
  const now = Math.floor(Date.now() / 1000);
  for (const name of ["debian-binary", "control.tar.gz", "data.tar.xz"]) {
    const data = readFileSync(join(work, name));
    const field = (v, n) => String(v).padEnd(n, " ").slice(0, n);
    parts.push(Buffer.from(field(name, 16) + field(now, 12) + field(0, 6) + field(0, 6) + field("100644", 8) + field(data.length, 10) + "`\n", "ascii"));
    parts.push(data);
    if (data.length % 2) parts.push(Buffer.from("\n"));
  }
  writeFileSync(out, Buffer.concat(parts));
}
rmSync(work, { recursive: true, force: true });
console.log(`Built ${basename(out)}`);

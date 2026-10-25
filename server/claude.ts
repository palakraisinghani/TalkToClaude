import { execFile, spawn } from "node:child_process";
import { chmod, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Is Claude Code ready to work for ClaudeCall? Every agent is a `claude` process, so without it
 * installed and signed in nothing can happen — and the call would only fail later, confusingly.
 * The page asks this when it connects and shows what is missing, with a way to fix it.
 */
export interface ClaudeStatus {
  installed: boolean;
  version?: string;
  loggedIn: boolean;
  /** How it is signed in: "claude.ai", "console", "api key", "vertex", "bedrock"… */
  method?: string;
  /** An API key saved in ClaudeCall is what it is using. */
  savedKey: boolean;
}

/** Where an API key typed into ClaudeCall is kept: readable by this user only. */
export const KEY_FILE = join(homedir(), ".config", "claudecall", "anthropic-key");

export async function claudeStatus(): Promise<ClaudeStatus> {
  const savedKey = !!process.env.CLAUDECALL_SAVED_KEY;
  let version: string | undefined;
  try {
    version = (await run("claude", ["--version"], { timeout: 15_000 })).stdout.trim().split(/\s/)[0];
  } catch {
    return { installed: false, loggedIn: false, savedKey };
  }
  try {
    const { stdout } = await run("claude", ["auth", "status", "--json"], { timeout: 15_000 });
    const s = JSON.parse(stdout);
    const method = s.apiProvider && s.apiProvider !== "firstParty" ? s.apiProvider : ({ claudeai: "claude.ai", oauth_token: "claude.ai", console: "console", api_key: "api key" } as Record<string, string>)[s.authMethod] ?? s.authMethod;
    return { installed: true, version, loggedIn: !!s.loggedIn, method, savedKey };
  } catch {
    // an older Claude Code without "auth status": assume it is signed in, as it was before
    return { installed: true, version, loggedIn: true, savedKey };
  }
}

/**
 * Open a terminal on this computer running Claude Code's own sign-in, which opens the browser.
 * ClaudeCall never sees the password or the token: Claude Code stores them where it always does.
 * `kind`: "claudeai" for a Claude subscription, "console" for API billing.
 */
export async function openSignIn(kind: "claudeai" | "console"): Promise<void> {
  const cmd = `claude auth login --${kind}`;
  if (process.platform === "darwin") {
    await run("osascript", ["-e", `tell application "Terminal" to do script "${cmd}"`, "-e", 'tell application "Terminal" to activate']);
    return;
  }
  // the first terminal this Linux desktop has
  for (const [term, ...args] of [["x-terminal-emulator", "-e"], ["gnome-terminal", "--"], ["konsole", "-e"], ["xfce4-terminal", "-x"], ["xterm", "-e"]]) {
    const ok = await new Promise<boolean>((resolve) => {
      const child = spawn(term, [...args, "sh", "-c", `${cmd}; echo; read -p "Press Enter to close" _`], { detached: true, stdio: "ignore" });
      child.once("error", () => resolve(false));
      child.once("spawn", () => { child.unref(); resolve(true); });
    });
    if (ok) return;
  }
  throw new Error(`No terminal was found. Run "${cmd}" on this computer.`);
}

/** Load a key saved earlier, so every agent started from here uses it. Your own environment wins. */
export async function loadSavedKey(): Promise<void> {
  if (process.env.ANTHROPIC_API_KEY) return;
  const key = (await readFile(KEY_FILE, "utf8").catch(() => "")).trim();
  if (!key) return;
  process.env.ANTHROPIC_API_KEY = key;
  process.env.CLAUDECALL_SAVED_KEY = "1";
}

/** Keep an Anthropic API key for the agents. Returns a problem in words, or null. */
export async function saveKey(key: string): Promise<string | null> {
  const k = key.trim();
  if (!/^sk-ant-[\w-]{20,}$/.test(k)) return "That does not look like an Anthropic API key: they start with sk-ant-.";
  await mkdir(dirname(KEY_FILE), { recursive: true });
  await writeFile(KEY_FILE, k + "\n", { mode: 0o600 });
  await chmod(KEY_FILE, 0o600);
  process.env.ANTHROPIC_API_KEY = k;
  process.env.CLAUDECALL_SAVED_KEY = "1";
  return null;
}

export async function forgetKey(): Promise<void> {
  await rm(KEY_FILE, { force: true });
  if (process.env.CLAUDECALL_SAVED_KEY) {
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.CLAUDECALL_SAVED_KEY;
  }
}

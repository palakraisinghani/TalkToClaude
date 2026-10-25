import { readdir, readFile, stat } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { homedir } from "node:os";
import { join } from "node:path";

export interface PastSession {
  id: string;
  /** When it was last written to. */
  at: number;
  /** The first thing the person asked, for reading out. */
  label: string;
  file: string;
}

const projectsRoot = () => process.env.BUDDY_CLAUDE_HOME ?? join(homedir(), ".claude", "projects");

/**
 * Claude Code names a project folder after its path with the punctuation flattened. That is a
 * guess about someone else's layout, so it is only ever used as a fast path: the authority is the
 * `cwd` recorded inside the session files themselves.
 */
const encode = (dir: string) => dir.replace(/[^a-zA-Z0-9]/g, "-");

/** The first line that carries a cwd, which says which directory a session belongs to. */
async function cwdOf(file: string): Promise<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    let n = 0;
    for await (const line of rl) {
      if (++n > 40) break;
      try {
        const d = JSON.parse(line);
        if (typeof d?.cwd === "string") return d.cwd;
      } catch { /* a partially written line is not worth failing over */ }
    }
    return "";
  } finally {
    rl.close();
  }
}

/** The first thing the person said, with our own call tag stripped back off. */
async function labelOf(file: string): Promise<string> {
  const rl = createInterface({ input: createReadStream(file, { encoding: "utf8" }), crlfDelay: Infinity });
  try {
    let n = 0;
    for await (const line of rl) {
      if (++n > 200) break;
      let d: any;
      try { d = JSON.parse(line); } catch { continue; }
      if (d?.type !== "user") continue;
      const c = d.message?.content;
      const text = typeof c === "string" ? c : Array.isArray(c) ? (c.find((x: any) => x?.type === "text")?.text ?? "") : "";
      const clean = String(text)
        .replace(/\[call · [^\]]*\]\s*/g, "")
        .replace(/\[cut in:[^\]]*\]\s*/g, "")
        .replace(/\[permission granted out loud\][^.]*\.\s*/g, "")
        .trim();
      if (clean) return clean.length > 120 ? clean.slice(0, 119) + "…" : clean;
    }
    return "";
  } finally {
    rl.close();
  }
}

async function sessionsIn(folder: string, dir: string, out: Map<string, PastSession>): Promise<void> {
  let names: string[];
  try {
    names = await readdir(folder);
  } catch {
    return;
  }
  await pool(names.filter((n) => n.endsWith(".jsonl")), 8, async (name) => {
    const file = join(folder, name);
    if ((await cwdOf(file).catch(() => "")) !== dir) return;
    const id = name.slice(0, -".jsonl".length);
    if (out.has(id)) return;
    const st = await stat(file).catch(() => null);
    if (!st || st.size === 0) return;
    out.set(id, { id, at: st.mtimeMs, label: await labelOf(file).catch(() => ""), file });
  });
}

/** Run `fn` over `items`, at most `n` at a time: hundreds of session files read without a queue of hundreds. */
async function pool<T>(items: T[], n: number, fn: (x: T) => Promise<void>): Promise<void> {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  }));
}

/**
 * Past Claude sessions for a directory, newest first. Reads only what the CLI already wrote, so
 * there is nothing to keep in step: whatever you have talked to Claude about in that folder,
 * from this app or from the terminal, shows up here and can be resumed.
 */
export async function findSessions(dir: string): Promise<PastSession[]> {
  const root = projectsRoot();
  const found = new Map<string, PastSession>();
  // the folder the CLI most likely used: if it has them, that is the answer, and quick
  await sessionsIn(join(root, encode(dir)), dir, found);
  if (found.size) return [...found.values()].sort((a, b) => b.at - a.at);
  // otherwise everything else, because the naming scheme is not ours to rely on
  let folders: string[] = [];
  try {
    folders = await readdir(root);
  } catch {
    return [...found.values()];
  }
  await pool(folders.filter((f) => f !== encode(dir)), 4, (f) => sessionsIn(join(root, f), dir, found));
  return [...found.values()].sort((a, b) => b.at - a.at);
}

/** "two hours ago", for saying out loud. */
export function ago(at: number, now = Date.now()): string {
  const mins = Math.round((now - at) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} minute${mins === 1 ? "" : "s"} ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days} day${days === 1 ? "" : "s"} ago`;
  return `${Math.round(days / 30)} months ago`;
}

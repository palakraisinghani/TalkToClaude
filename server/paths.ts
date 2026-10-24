import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

/**
 * Working out which folder someone meant when they said it out loud.
 *
 * Spoken paths arrive mangled: "tilde slash code slash api", or just "scraper", or "my
 * iiscacads courses" with the slashes swallowed entirely. So two passes. First the words are read
 * literally, which handles anyone who dictates punctuation. If that is not a real directory, the
 * words become a search instead: folders are looked for whose name matches what was said, with
 * the earlier words used to choose between namesakes.
 *
 * Typing is always available and always exact; this is for when talking is easier.
 */

const SEPARATORS: Record<string, string> = {
  slash: "/", "forward-slash": "/", backslash: "/",
  dot: ".", period: ".", point: ".",
  dash: "-", hyphen: "-", minus: "-",
  underscore: "_", "under-score": "_",
};

const HOME_WORDS = new Set(["tilde", "home", "~"]);
const NOISE = new Set(["the", "a", "my", "folder", "directory", "dir", "project", "repo", "repository", "called", "named", "in", "at", "under", "inside"]);

const words = (t: string) => t.toLowerCase().replace(/[^\w~/.\- ]/g, " ").split(/\s+/).filter(Boolean);
const flat = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

export const expandHome = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** Read the words as dictated punctuation. Returns "" when nothing path-like was said. */
export function spokenToPath(text: string): string {
  const ws = words(text);
  if (!ws.length) return "";
  // already a real path, typed rather than spoken
  if (/[/~]/.test(text) && !/\bslash\b|\btilde\b/.test(text)) return text.trim();
  let out = "";
  let sawSeparator = false;
  for (const w of ws) {
    if (HOME_WORDS.has(w)) { out += "~"; sawSeparator = true; continue; }
    const sep2 = SEPARATORS[w];
    if (sep2) { out += sep2; sawSeparator = true; continue; }
    if (NOISE.has(w) && !out) continue;
    // a word landing straight after another word is its own segment
    out += out && !/[/.\-_~]$/.test(out) ? `/${w}` : w;
  }
  return sawSeparator || out.includes("/") ? out : out;
}

/** The content words, with punctuation words and filler dropped, for searching. */
export function searchWords(text: string): string[] {
  return words(text)
    .filter((w) => !SEPARATORS[w] && !HOME_WORDS.has(w) && !NOISE.has(w))
    .flatMap((w) => w.split(/[/.\-_]+/))
    .filter(Boolean);
}

const SKIP = new Set(["node_modules", "dist", "build", "out", "target", "venv", "__pycache__", "Library", "Applications", "System", ".git"]);

/** Directories worth searching when a spoken name has to be looked up. */
export function searchRoots(appRoot: string): string[] {
  const h = homedir();
  const named = (process.env.BUDDY_SEARCH_ROOTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (named.length) return named.map(expandHome);
  return [appRoot, join(h, "code"), join(h, "projects"), join(h, "Projects"), join(h, "my"), join(h, "src"), join(h, "Documents"), join(h, "Developer"), h];
}

interface Candidate { dir: string; score: number }

/**
 * Look for a directory whose name is what was said. The last words name the folder; any earlier
 * words have to appear somewhere above it, which is what separates two folders of the same name.
 */
async function search(ws: string[], roots: string[], depth = 4, budget = 6000): Promise<Candidate[]> {
  if (!ws.length) return [];
  const target = ws.join("");
  const hits: Candidate[] = [];
  const seen = new Set<string>();
  let visited = 0;

  const walk = async (dir: string, level: number): Promise<void> => {
    if (level > depth || visited > budget) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".claude")) continue;
      visited++;
      const full = join(dir, e.name);
      if (seen.has(full)) continue;
      seen.add(full);
      const name = flat(e.name);
      if (name === target || (target.length >= 4 && name.startsWith(target))) {
        // earlier words must show up above it; each one that does makes this the better guess
        const above = flat(full.split(sep).slice(0, -1).join(" "));
        const context = ws.slice(0, -1).filter((w) => above.includes(flat(w))).length;
        hits.push({ dir: full, score: 100 + context * 10 - level + (name === target ? 5 : 0) });
      }
      await walk(full, level + 1);
    }
  };

  for (const r of roots) await walk(r, 1);
  return hits.sort((a, b) => b.score - a.score);
}

export interface Resolved {
  kind: "ok" | "missing" | "ambiguous" | "empty";
  dir?: string;
  /** What was understood, for reading back before anything is opened. */
  heard?: string;
  options?: string[];
}

/**
 * Turn something spoken or typed into one directory. A path that exists is taken as given; a
 * name is searched for; two folders of the same name are reported rather than guessed at,
 * because opening the wrong repository is not a harmless mistake.
 */
export async function resolveDir(text: string, appRoot: string): Promise<Resolved> {
  const literalRaw = spokenToPath(text);
  if (!literalRaw.trim()) return { kind: "empty" };
  const literal = resolve(appRoot, expandHome(literalRaw));
  const isDir = await stat(literal).then((s) => s.isDirectory()).catch(() => false);
  if (isDir) return { kind: "ok", dir: literal, heard: literalRaw };

  const ws = searchWords(text);
  const hits = await search(ws, searchRoots(appRoot));
  if (!hits.length) {
    // an absolute or tilde path that simply is not there yet: report it so it can be created
    const explicit = /^[~/]/.test(literalRaw.trim()) || isAbsolute(literalRaw.trim());
    return { kind: "missing", dir: explicit ? literal : undefined, heard: literalRaw };
  }
  const best = hits[0];
  const tied = hits.filter((h) => h.score === best.score);
  if (tied.length > 1) return { kind: "ambiguous", options: tied.slice(0, 4).map((h) => h.dir), heard: ws.join(" ") };
  return { kind: "ok", dir: best.dir, heard: basename(best.dir) };
}

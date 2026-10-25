import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CENTRAL_ID, identityFor, type Identity } from "./identity.ts";

/** Permission modes the CLI accepts. `auto` asks only about what its safety check judges risky. */
export type PermissionMode = "auto" | "acceptEdits" | "manual" | "plan" | "default" | "dontAsk" | "bypassPermissions";

/** How much a project talks: on the line, or working quietly in the background. */
export type Engagement = "pair" | "delegate";

export interface ProjectConfig {
  id: string;
  /** The name you call it by. Short, one word, phonetically distinct: it is matched from speech. */
  name: string;
  dir: string;
  identity: Identity;
  /** Used while the project is on the line. */
  permissionMode: PermissionMode;
  /** Used while it works in the background, where nobody is listening to approve things. */
  backgroundPermissionMode: PermissionMode;
  engagement: Engagement;
  /** A past Claude session to pick up when this project's agent is first started. */
  resume?: string;
  /** Extra instructions from the lead for this agent alone, added to its system prompt. */
  prompt?: string;
}

interface RawProject {
  name?: string;
  dir?: string;
  voice?: string;
  pitch?: number;
  rate?: number;
  pan?: number;
  hue?: number;
  permissionMode?: PermissionMode;
  backgroundPermissionMode?: PermissionMode;
  engagement?: Engagement;
  prompt?: string;
}

export const CONFIG_FILE = "buddy.projects.json";

const MODES: PermissionMode[] = ["auto", "acceptEdits", "manual", "plan", "default", "dontAsk", "bypassPermissions"];

const expand = (p: string) => (p.startsWith("~") ? join(homedir(), p.slice(1)) : p);

/** A name that can be said and recognised: one word, letters only, distinct from the others. */
function slug(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
}

function titleCase(s: string): string {
  const word = s.replace(/[^a-zA-Z0-9]+/g, " ").trim().split(/\s+/)[0] || "project";
  return word[0].toUpperCase() + word.slice(1);
}

function mode(v: unknown, fallback: PermissionMode): PermissionMode {
  return MODES.includes(v as PermissionMode) ? (v as PermissionMode) : fallback;
}

/** A project remembered from an earlier call: enough to reopen it and pick up its conversation. */
export interface SavedProject {
  name: string;
  dir: string;
  sessionId?: string;
  prompt?: string;
}

/** The projects opened in earlier calls. A missing or broken file just means none. */
export async function loadSaved(file: string): Promise<SavedProject[]> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const list = Array.isArray(parsed?.projects) ? parsed.projects : [];
    return list.filter((p: any) => typeof p?.dir === "string" && typeof p?.name === "string");
  } catch {
    return [];
  }
}

/** Remember the roster, written whole and renamed into place so a crash never leaves half a file. */
export async function saveRoster(file: string, projects: SavedProject[]): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  await writeFile(tmp, JSON.stringify({ projects }, null, 2) + "\n");
  await rename(tmp, file);
}

/**
 * Read the roster. `buddy.projects.json` next to the app wins; otherwise BUDDY_PROJECTS, a
 * comma-separated list of directories. Projects remembered from earlier calls follow, unless the
 * same folder is already listed. None at all is normal: the central agent opens projects when
 * asked, and is always on the call herself.
 */
export async function loadProjects(root: string, fallbackDir: string, saved: SavedProject[] = []): Promise<ProjectConfig[]> {
  let raw: RawProject[] = [];
  try {
    const parsed = JSON.parse(await readFile(join(root, CONFIG_FILE), "utf8"));
    raw = Array.isArray(parsed) ? parsed : (parsed.projects ?? []);
    if (!Array.isArray(raw)) throw new Error(`${CONFIG_FILE}: expected an array of projects`);
  } catch (e: any) {
    if (e?.code !== "ENOENT") throw new Error(`${CONFIG_FILE} could not be read: ${e.message}`);
    const dirs = (process.env.BUDDY_PROJECTS ?? "").split(",").map((d) => d.trim()).filter(Boolean);
    // no roster at all is the normal case: Ada opens projects when you ask her to
    raw = dirs.map((dir) => ({ dir }));
  }

  // a remembered project comes back under the same name, with its conversation
  const listed = new Set(raw.map((p) => resolve(root, expand(p.dir ?? fallbackDir))));
  const resumes = new Map<number, string>();
  for (const s of saved) {
    if (listed.has(s.dir)) continue;
    listed.add(s.dir);
    if (s.sessionId) resumes.set(raw.length, s.sessionId);
    raw.push({ name: s.name, dir: s.dir, prompt: s.prompt });
  }

  // the central agent's name is taken before anyone else's: you must always be able to reach her
  const used = new Set<string>([CENTRAL_ID]);
  return raw.map((p, i) => {
    // a relative dir in the config is relative to the app, so a checked-in roster is portable
    const dir = resolve(root, expand(p.dir ?? fallbackDir));
    if (!isAbsolute(dir)) throw new Error(`project ${i + 1}: dir must resolve to an absolute path`);
    let name = titleCase(p.name ?? basename(dir));
    // names are said out loud and matched from speech, so they have to be unique
    for (let n = 2; used.has(slug(name)); n++) name = `${titleCase(p.name ?? basename(dir))}${n}`;
    used.add(slug(name));
    const base = identityFor(i);
    return {
      id: slug(name),
      name,
      dir,
      identity: {
        voices: p.voice ? [p.voice, ...base.voices] : base.voices,
        pitch: p.pitch ?? base.pitch,
        rate: p.rate ?? base.rate,
        pan: Math.max(-1, Math.min(1, p.pan ?? base.pan)),
        earcon: base.earcon,
        hue: p.hue ?? base.hue,
      },
      // auto everywhere: the safety check lets ordinary work through, and anything it judges risky
      // pauses the agent until you answer — on the line or in the background, through the head
      permissionMode: mode(p.permissionMode, "auto"),
      backgroundPermissionMode: mode(p.backgroundPermissionMode, "auto"),
      engagement: p.engagement === "delegate" ? "delegate" : "pair",
      resume: resumes.get(i),
      prompt: typeof p.prompt === "string" && p.prompt.trim() ? p.prompt.trim() : undefined,
    };
  });
}

/** The current git branch of a project, for the roster display. Cheap and best-effort. */
/**
 * A project made during a call rather than read from a file. The name comes from the folder, the
 * identity from its position in the roster, and both are kept clear of what is already in use.
 */
export function projectFor(dir: string, index: number, taken: Iterable<string>, overrides: RawProject = {}): ProjectConfig {
  const used = new Set([CENTRAL_ID, ...taken]);
  const wanted = titleCase(overrides.name ?? basename(dir));
  let name = wanted;
  for (let n = 2; used.has(slug(name)); n++) name = `${wanted}${n}`;
  const base = identityFor(index);
  return {
    id: slug(name),
    name,
    dir,
    identity: {
      voices: overrides.voice ? [overrides.voice, ...base.voices] : base.voices,
      pitch: overrides.pitch ?? base.pitch,
      rate: overrides.rate ?? base.rate,
      pan: Math.max(-1, Math.min(1, overrides.pan ?? base.pan)),
      earcon: base.earcon,
      hue: overrides.hue ?? base.hue,
    },
    permissionMode: mode(overrides.permissionMode, "auto"),
    backgroundPermissionMode: mode(overrides.backgroundPermissionMode, "auto"),
    engagement: overrides.engagement === "delegate" ? "delegate" : "pair",
    prompt: overrides.prompt?.trim() || undefined,
  };
}

export async function branchOf(dir: string): Promise<string> {
  try {
    const head = await readFile(join(dir, ".git", "HEAD"), "utf8");
    const m = /^ref: refs\/heads\/(.+)$/m.exec(head.trim());
    return m ? m[1] : head.trim().slice(0, 7);
  } catch {
    return "";
  }
}

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { CENTRAL_ID, centralName, identityFor, type Identity } from "./identity.ts";
import { confusable } from "../web/route.js";
import { usableAlias } from "../web/words.js";

/** Names that are short, easy to say, and far apart in sound: offered when a wanted one is not. */
const SPARE_NAMES = ["Felix", "Nova", "Theo", "Kai", "Sage", "Leo", "Wren", "Hugo", "Luna", "Finn", "Ruby", "Zara", "Pip", "Rex", "Bea", "Cosmo"];

/**
 * A name nobody will mix up with another on the call: the one wanted when it is clear of the
 * others, otherwise the first spare that is. Names are matched from speech, so "Otto" next to
 * "Ada" (or "Mila" next to "Milo") would make one of them hard to reach.
 */
export function clearName(wanted: string, others: string[]): string {
  const taken = (n: string) => others.some((o) => o.toLowerCase() === n.toLowerCase());
  if (!taken(wanted) && !confusable(wanted, others)) return wanted;
  return SPARE_NAMES.find((n) => !taken(n) && !confusable(n, others)) ?? `${wanted}${others.length + 1}`;
}

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
  /** How it sounds, when the lead or the agent changed it: kept so it survives restarts. */
  sound?: Sound;
  /** Extra instructions from the lead for this agent alone, added to its system prompt. */
  prompt?: string;
  /** Other spellings the speech recognizer gives this name ("Mylo" for Milo), matched like the name. */
  aliases?: string[];
  /** The Claude model this agent runs on ("opus", "sonnet", a full id); unset means Claude Code's default. */
  model?: string;
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
  aliases?: string[];
  model?: string;
  sound?: Sound;
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

/** Alternative spellings of a name: single words, letters only, a handful at most. */
export function aliasesOf(v: unknown): string[] | undefined {
  if (!Array.isArray(v)) return undefined;
  // everyday words never become names: an agent answering to "do" would take every "do the tests"
  const out = [...new Set(v.map((a) => String(a).trim().toLowerCase()).filter(usableAlias))].slice(0, 12);
  return out.length ? out : undefined;
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
  aliases?: string[];
  model?: string;
  /** How it sounds, as the lead (or the agent itself) set it. */
  sound?: Sound;
}

/** An agent's voice as it can be changed: which system voice, how fast, how high, how loud, which side. */
export interface Sound { voice?: string; rate?: number; pitch?: number; volume?: number; pan?: number }

const clamp = (v: unknown, lo: number, hi: number) => (typeof v === "number" && Number.isFinite(v) ? Math.max(lo, Math.min(hi, v)) : undefined);
/** A sound setting with anything out of range or not a number left out. */
export function soundOf(v: any): Sound | undefined {
  if (!v || typeof v !== "object") return undefined;
  const s: Sound = {
    voice: typeof v.voice === "string" && v.voice.trim() ? v.voice.trim().slice(0, 60) : undefined,
    rate: clamp(v.rate, 0.6, 1.8), pitch: clamp(v.pitch, 0.5, 1.6), volume: clamp(v.volume, 0, 1), pan: clamp(v.pan, -1, 1),
  };
  const kept = Object.fromEntries(Object.entries(s).filter(([, x]) => x !== undefined)) as Sound;
  return Object.keys(kept).length ? kept : undefined;
}
/** An identity with a sound setting laid over it: a chosen voice goes first among its candidates. */
export function withSound(id: Identity, sound?: Sound): Identity {
  if (!sound) return id;
  return {
    ...id,
    voices: sound.voice ? [sound.voice, ...id.voices.filter((v) => v !== sound.voice)] : id.voices,
    rate: sound.rate ?? id.rate, pitch: sound.pitch ?? id.pitch, pan: sound.pan ?? id.pan, volume: sound.volume ?? id.volume,
  };
}

/** Settings for the assistant herself, kept beside the roster. */
export interface SavedCentral {
  model?: string;
  /** What the lead calls her, when they have renamed her. */
  name?: string;
  /** How the lead's own voice comes out when they say her name, as the recognizer writes it. */
  aliases?: string[];
  /** How she sounds, when changed. */
  sound?: Sound;
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

/** The assistant's own settings from the roster file; none if it is missing or broken. */
export async function loadCentral(file: string): Promise<SavedCentral> {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    const c = parsed?.central ?? {};
    const name = typeof c.name === "string" && /^[A-Za-z][A-Za-z']{1,19}$/.test(c.name.trim()) ? c.name.trim() : undefined;
    return { model: modelOf(c.model), name, aliases: aliasesOf(c.aliases), sound: soundOf(c.sound) };
  } catch {
    return {};
  }
}

/** A model name as the CLI takes it: an alias like "sonnet" or a full id. Anything else is dropped. */
export function modelOf(v: unknown): string | undefined {
  const s = typeof v === "string" ? v.trim() : "";
  return /^[a-z0-9][a-z0-9.\-\[\]]{1,63}$/i.test(s) && s !== "default" ? s : undefined;
}

/** Remember the roster, written whole and renamed into place so a crash never leaves half a file. */
export async function saveRoster(file: string, projects: SavedProject[], central: SavedCentral = {}): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  const keep = Object.fromEntries(Object.entries(central).filter(([, v]) => v !== undefined && !(Array.isArray(v) && !v.length)));
  await writeFile(tmp, JSON.stringify(Object.keys(keep).length ? { central: keep, projects } : { projects }, null, 2) + "\n");
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
    raw.push({ name: s.name, dir: s.dir, prompt: s.prompt, aliases: s.aliases, model: s.model, sound: soundOf(s.sound) });
  }

  // the central agent's name is taken before anyone else's: you must always be able to reach her
  const used = new Set<string>([CENTRAL_ID]);
  const names: string[] = [centralName()];
  return raw.map((p, i) => {
    // a relative dir in the config is relative to the app, so a checked-in roster is portable
    const dir = resolve(root, expand(p.dir ?? fallbackDir));
    if (!isAbsolute(dir)) throw new Error(`project ${i + 1}: dir must resolve to an absolute path`);
    // names are said out loud and matched from speech, so they must be unique and not sound alike
    const wanted = titleCase(p.name ?? basename(dir));
    let name = clearName(wanted, names);
    if (name !== wanted) console.warn(`"${wanted}" sounds too much like ${confusable(wanted, names) ?? "another name"} on the call; calling it ${name} instead.`);
    for (let n = 2; used.has(slug(name)); n++) name = `${wanted}${n}`;
    used.add(slug(name));
    names.push(name);
    const base = identityFor(i);
    return {
      id: slug(name),
      name,
      dir,
      identity: withSound({
        voices: p.voice ? [p.voice, ...base.voices] : base.voices,
        pitch: p.pitch ?? base.pitch,
        rate: p.rate ?? base.rate,
        pan: Math.max(-1, Math.min(1, p.pan ?? base.pan)),
        earcon: base.earcon,
        hue: p.hue ?? base.hue,
      }, p.sound),
      sound: p.sound,
      // auto everywhere: the safety check lets ordinary work through, and anything it judges risky
      // pauses the agent until you answer — on the line or in the background, through the head
      permissionMode: mode(p.permissionMode, "auto"),
      backgroundPermissionMode: mode(p.backgroundPermissionMode, "auto"),
      engagement: p.engagement === "delegate" ? "delegate" : "pair",
      resume: resumes.get(i),
      prompt: typeof p.prompt === "string" && p.prompt.trim() ? p.prompt.trim() : undefined,
      aliases: aliasesOf(p.aliases),
      model: modelOf(p.model),
    };
  });
}

/** The current git branch of a project, for the roster display. Cheap and best-effort. */
/**
 * A project made during a call rather than read from a file. The name comes from the folder, the
 * identity from its position in the roster, and both are kept clear of what is already in use.
 */
export function projectFor(dir: string, index: number, taken: Iterable<string>, overrides: RawProject = {}, names: string[] = []): ProjectConfig {
  const used = new Set([CENTRAL_ID, ...taken]);
  const wanted = titleCase(overrides.name ?? basename(dir));
  let name = clearName(wanted, [centralName(), ...names]);
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
    aliases: aliasesOf(overrides.aliases),
    model: modelOf(overrides.model),
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

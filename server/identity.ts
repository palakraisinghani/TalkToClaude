/**
 * Who each project sounds like. Only one project is ever on the line, but you still need to know
 * at a glance — and at an earcon — which one is talking, so each gets a voice, a stereo position
 * and a colour, assigned in roster order and stable across restarts.
 *
 * The voice names are candidates, most preferred first: the page picks the first one the browser
 * actually has. They are chosen to differ by accent, which the ear separates far better than
 * pitch, and none of them is the central voice (Samantha), which must always stand apart.
 */
export interface Identity {
  /** Candidate speechSynthesis voice names, best first. */
  voices: string[];
  pitch: number;
  rate: number;
  /** Stereo position of this project's earcon, -1 hard left to +1 hard right. */
  pan: number;
  /** Two-note earcon in Hz, played before the project speaks. */
  earcon: [number, number];
  /** Hue for the orb and the panel, 0-360. */
  hue: number;
  /** How loud this agent speaks, 0–1. */
  volume?: number;
}

/** The central voice's name when nothing else is set: always present, never one of the projects. */
export const CENTRAL_NAME = process.env.BUDDY_CENTRAL_NAME ?? "Ada";
let currentName = CENTRAL_NAME;

/** Her name now. The lead can change it; it is kept with the roster. */
export const centralName = (): string => currentName;
export function setCentralName(name: string): void {
  currentName = name;
}

/**
 * How speech recognizers commonly write "Ada" when it is said on its own. Matched exactly, like
 * her name, so "Aida, what is Milo doing?" reaches her too, not only a bare "Aida". Any other
 * name starts with none; the lead teaches the app how they say it instead.
 */
export const builtinAliases = (name: string): string[] => name.toLowerCase() === "ada"
  ? ["aida", "ayda", "aider", "adah", "adda", "ader", "eda", "edda", "etta", "ida", "aada", "ata"]
  : [];
export const CENTRAL_ALIASES = builtinAliases(CENTRAL_NAME);

/** Her id on the wire. Fixed for the life of the install, whatever she is called; no project can take it. */
export const CENTRAL_ID = CENTRAL_NAME.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "central";

export const CENTRAL: Identity = {
  voices: ["Samantha", "Microsoft Aria Online (Natural) - English (United States)", "Google US English"],
  pitch: 1,
  rate: 1.05,
  pan: 0,
  earcon: [660, 880],
  hue: 18,
};

const POOL: Identity[] = [
  { voices: ["Daniel", "Google UK English Male", "Microsoft George"], pitch: 1.0, rate: 1.05, pan: -0.7, earcon: [523, 659], hue: 210 },
  { voices: ["Karen", "Google UK English Female", "Microsoft Hazel"], pitch: 1.0, rate: 1.08, pan: 0.7, earcon: [587, 784], hue: 145 },
  { voices: ["Moira", "Microsoft Libby"], pitch: 1.05, rate: 1.02, pan: -0.35, earcon: [494, 622], hue: 275 },
  { voices: ["Tessa", "Microsoft Ryan"], pitch: 0.95, rate: 1.06, pan: 0.35, earcon: [622, 831], hue: 45 },
  { voices: ["Aman", "Rishi", "Microsoft Ravi"], pitch: 1.0, rate: 1.0, pan: -0.55, earcon: [466, 587], hue: 330 },
  { voices: ["Fiona", "Microsoft Linda"], pitch: 1.1, rate: 1.04, pan: 0.55, earcon: [698, 932], hue: 95 },
];

/** The identity for the nth project in the roster, wrapping (with a pitch nudge) past the pool. */
export function identityFor(index: number): Identity {
  const base = POOL[index % POOL.length];
  const wrap = Math.floor(index / POOL.length);
  if (!wrap) return base;
  return { ...base, pitch: Number((base.pitch + wrap * 0.12).toFixed(2)), hue: (base.hue + wrap * 37) % 360 };
}

export const poolSize = POOL.length;

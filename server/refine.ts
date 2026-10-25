import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSession } from "./agent.ts";
import type { Agent, AgentEvent } from "./types.ts";

/**
 * A clean-up pass between speech recognition and the agents.
 *
 * The recognizer runs on this machine and is quick, but it misses names and technical terms
 * ("pie test" for pytest, "get hub", "jason") and keeps the ums. Before what the lead said reaches
 * an agent, a small Claude Haiku session, with no tools and nothing to act on, fixes what was
 * plainly misheard, using the team's names and the words of the project as context. It never
 * adds or answers anything, and when it is slow or unsure the lead's words go through as heard.
 *
 * Measured: with thinking left on, Haiku took 2–10s to start replying; with it off, a warm
 * session answers in 0.8–1.05s. A plain corrected sentence is quicker and steadier than JSON.
 */

export interface HearingContext {
  /** Who the words are for. */
  to: string;
  /** Everyone's name on the call, with the spellings each answers to. */
  team: string[];
  /** Words from the agent's recent work: file names, commands, identifiers. */
  terms: string[];
  /** What that agent said last, so an answer to its question reads right. */
  agentLastSaid: string[];
  /** The lead's accent, when they have said it ("Indian English"): its usual mishearings are expected. */
  accent?: string;
}

export interface Refined {
  text: string;
  /** The words differ from what was heard (not just punctuation or capitals). */
  changed: boolean;
  ms: number;
  /** Why it went through as heard, when it did. */
  skipped?: "short" | "timeout" | "unusable" | "off";
}

export const REFINE_PROMPT = [
  "You fix speech-recognition transcripts before they reach a coding agent on a voice call.",
  'Each message is JSON: "heard" (the transcript), "to" (who it is for), "team" (names on the call), "terms" (words from their project), "agentLastSaid" (what that agent just said), and sometimes "accent" (how the speaker speaks).',
  "Fix only what is clearly misrecognised: names from the team, technical terms and file names from terms, programming words (pytest, GitHub, JSON, npm, API), and obvious homophones.",
  "When a heard word sounds like one in terms, it is probably that word (\"off\" next to auth.py means auth).",
  "Keep the speaker's own spelling: never change British to American spelling or the reverse, and never touch a word that was heard correctly.",
  "Drop fillers (um, uh, like, you know) and false starts. Add punctuation and capitals.",
  "Never add words or ideas, never answer or comment, never change what is being asked, never translate.",
  "If you are not sure a word is wrong, leave it as heard.",
  'When "accent" is given, the speaker has that accent, and the recognizer mishears it in its usual ways. For Indian English expect: v and w swapped, "th" heard as t or d, a sound added or dropped at the start of a word ("Bada" or "He had a" for Ada, "photo" for Otto), vowels shifted ("Juno" heard as "Jun"), and stress on unexpected syllables. Correct names and terms with that in mind.',
  "Reply with the corrected sentence only: no quotes, no explanation.",
].join(" ");

const words = (s: string) => s.toLowerCase().replace(/[^\w' ]/g, " ").split(/\s+/).filter(Boolean);
/** Same words, ignoring punctuation, capitals and dropped fillers. */
const FILLERS = new Set(["um", "uh", "umm", "uhh", "er", "erm", "hmm"]);
const sameWords = (a: string, b: string) => words(a).filter((w) => !FILLERS.has(w)).join(" ") === words(b).filter((w) => !FILLERS.has(w)).join(" ");

/** Make a fresh Haiku session for the Refiner. */
async function haiku(): Promise<Agent> {
  const cwd = join(tmpdir(), "claudecall-refine");
  await mkdir(cwd, { recursive: true });
  return new ClaudeSession({
    cwd,
    systemPrompt: REFINE_PROMPT,
    replaceSystemPrompt: true,
    model: "haiku",
    permissionMode: "default",
    // no tools, no MCP servers, no settings files, nothing saved: a quick pass and nothing it can do
    extraArgs: ["--tools", "", "--strict-mcp-config", "--setting-sources", "", "--no-session-persistence", "--settings", JSON.stringify({ alwaysThinkingEnabled: false })],
    env: { MAX_THINKING_TOKENS: "0" },
  });
}

export class Refiner {
  private session: Agent | null = null;
  private making: Promise<Agent> | null = null;
  private uses = 0;
  private pending = new Map<number, { text: string; done: (text: string | null) => void }>();
  private readonly make: () => Promise<Agent>;
  private readonly timeoutMs: number;
  /** Requests before the session is replaced: its history grows with each one, and so would its latency. */
  private readonly maxUses: number;

  constructor({ make = haiku, timeoutMs = 2500, maxUses = 30 }: { make?: () => Promise<Agent>; timeoutMs?: number; maxUses?: number } = {}) {
    this.make = make;
    this.timeoutMs = timeoutMs;
    this.maxUses = maxUses;
  }

  /** Start the session ahead of time, so the first thing the lead says is not slow. */
  warm(): void {
    this.ensure().catch(() => {});
  }

  private async ensure(): Promise<Agent> {
    if (this.session && this.uses < this.maxUses) return this.session;
    if (this.making) return this.making;
    const old = this.session;
    this.session = null;
    this.uses = 0;
    this.making = this.make().then((s) => {
      s.on((turn, ev) => this.onEvent(turn, ev));
      s.start();
      this.session = s;
      this.making = null;
      return s;
    }, (e) => {
      // a failed start is not for ever: the next utterance tries again
      this.making = null;
      throw e;
    });
    const s = await this.making;
    old?.close();
    return s;
  }

  private onEvent(turn: number, ev: AgentEvent): void {
    const p = this.pending.get(turn);
    if (!p) return;
    if (ev.kind === "text") p.text += ev.text;
    else if (ev.kind === "done" || ev.kind === "error") {
      this.pending.delete(turn);
      p.done(ev.kind === "done" && !ev.interrupted ? p.text : null);
    }
  }

  async refine(heard: string, ctx: HearingContext): Promise<Refined> {
    const t0 = Date.now();
    const raw = heard.trim();
    // a word or two is a name, a yes, a command: the page already understood those
    if (words(raw).length <= 2) return { text: raw, changed: false, ms: 0, skipped: "short" };
    let out: string | null = null;
    try {
      const s = await this.ensure();
      this.uses++;
      out = await new Promise<string | null>((resolve) => {
        // newest wins: an older clean-up nobody is waiting for any more is cut, so one slow reply
        // never leaves the next few utterances queued behind it and missing their deadline too
        const turn = s.send(JSON.stringify({ heard: raw, ...ctx }), { interrupt: true });
        const timer = setTimeout(() => { this.pending.delete(turn); s.interrupt(); resolve(null); }, Math.max(0, this.timeoutMs - (Date.now() - t0)));
        this.pending.set(turn, { text: "", done: (t) => { clearTimeout(timer); resolve(t); } });
      });
    } catch {
      out = null;
    }
    const ms = Date.now() - t0;
    if (out === null) return { text: raw, changed: false, ms, skipped: "timeout" };
    const text = tidy(out);
    // an empty, much shorter or much longer reply is not a cleaned-up version of what was said
    const ratio = words(text).length / Math.max(1, words(raw).length);
    if (!text || ratio < 0.5 || ratio > 1.6) return { text: raw, changed: false, ms, skipped: "unusable" };
    const kept = keepSpelling(text, raw);
    return { text: kept, changed: !sameWords(kept, raw), ms };
  }

  close(): void {
    for (const p of this.pending.values()) p.done(null);
    this.pending.clear();
    this.session?.close();
    this.session = null;
  }
}

/** British and American spellings of a word, made the same: colour/color, summarise/summarize. */
const spellingKey = (w: string) => w.toLowerCase().replace(/isation/g, "ization").replace(/is(e|es|ed|ing)$/, "iz$1").replace(/ys(e|es|ed|ing)$/, "yz$1").replace(/our(s?)$/, "or$1").replace(/tre$/, "ter").replace(/ogue$/, "og").replace(/ll(ed|ing)$/, "l$1");

/**
 * Put back the speaker's own spelling where the model only swapped British for American (it does,
 * even when told not to): "summarise" stays "summarise". Matched word by word in order.
 */
export function keepSpelling(text: string, heard: string): string {
  const heardWords = heard.split(/\s+/).map((w) => w.replace(/[^\w']/g, ""));
  const pool = new Map<string, string[]>();
  for (const w of heardWords) if (w) pool.set(spellingKey(w), [...(pool.get(spellingKey(w)) ?? []), w]);
  return text.replace(/[A-Za-z']+/g, (w) => {
    const same = pool.get(spellingKey(w))?.find((h) => h.toLowerCase() !== w.toLowerCase());
    if (!same) return w;
    // keep the model's capitalisation, the speaker's letters
    return w[0] === w[0].toUpperCase() ? same[0].toUpperCase() + same.slice(1) : same;
  });
}

/** The reply, without quotes, code fences or a "Corrected:" label a model sometimes adds. */
export function tidy(reply: string): string {
  let t = reply.trim().replace(/^```\w*\s*|\s*```$/g, "").trim();
  t = t.split("\n").map((l) => l.trim()).filter(Boolean)[0] ?? "";
  t = t.replace(/^(corrected|transcript|text)\s*:\s*/i, "").replace(/^["“'](.*)["”']$/, "$1").trim();
  return t;
}

/** What the agent receives: the cleaned words, and when they differ, what the recognizer heard. */
export function forAgent(heard: string, r: Refined): string {
  return r.changed ? `${r.text} [speech recognition heard: "${heard.trim()}"]` : r.text;
}

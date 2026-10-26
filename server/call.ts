import { ClaudeSession } from "./agent.ts";
import { builtinAliases, CENTRAL, CENTRAL_ID, centralName, setCentralName } from "./identity.ts";
import { clean } from "./cleaner.ts";
import { callHeader, cutIn, type CallContext } from "./context.ts";
import { Notebook, teamChanges } from "./notebook.ts";
import { DEFAULT_MODEL } from "../web/models.js";
import { narrate, toolDetail, toolLabel } from "./narration.ts";
import { describeAction, notification, riskOf, ruleFor, summarise, type Notification } from "./notify.ts";
import { ReplyParser, type ParsedEvent } from "./parser.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveDir } from "./paths.ts";
import { ago, findSessions } from "./sessions.ts";
import { aliasesOf, branchOf, clearName, modelOf, projectFor, saveRoster, soundOf, withSound, type ProjectConfig, type Sound } from "./projects.ts";
import type { HearingContext } from "./refine.ts";
import { CENTRAL_NAME as CENTRAL_DEFAULT } from "./identity.ts";
import { confusable } from "../web/route.js";
import { Transcript } from "./transcript.ts";
import { changedSince, checkpoint, restore, type Checkpoint } from "./checkpoint.ts";
import type { Mode, Rewriter } from "./types.ts";

const FILLER_MS = 3500;
/** After this long on one stretch of work, the lead hears about it once. */
const LONG_WORK_MS = 25 * 60_000;
const NARRATE_GAP_MS = 6000;

export type ProjectState = "cold" | "warm" | "working" | "parked" | "blocked";

type Action = Extract<ParsedEvent, { kind: "action" }>;

/** An action an agent is paused on until a person says yes or no. */
interface Ask {
  /** The CLI's request id; the agent is waiting on this exact request. */
  requestId: string;
  tool: string;
  phrase: string;
  detail: string;
  reason: string;
  input: unknown;
  suggestions: unknown[];
  at: number;
  /**
   * Set when the safety check refused it outright rather than pausing to ask. The agent has
   * carried on without it; saying yes allows exactly this rule and asks the agent to try again.
   */
  retry?: string;
  /** Why this cannot be taken back, if it cannot: then it needs "confirm", not just "yes". */
  risk?: string;
}

/** Everything the server keeps for one agent — a project's, or the central one — for one call. */
class Project {
  readonly config: ProjectConfig;
  readonly central: boolean;
  session: ClaudeSession | null = null;
  transcript: Transcript | null = null;
  parsers = new Map<number, ReplyParser>();
  state: ProjectState = "cold";
  /** Sentences this project has produced in the running turn, for its own one-line report. */
  said: string[] = [];
  /** What it said after its last tool call: its answer, which leads with the verdict. */
  answer: string[] = [];
  /** The closing line of its last finished turn: what it would say if you asked how it is doing. */
  report = "";
  /** A <handoff> asked for this turn, carried out once the turn's own words have been said. */
  handoff: { to: string; note: string } | null = null;
  /** Picture files this agent touched lately, newest first: how a picture it pasted as text is recovered. */
  images: string[] = [];
  /** Words from its recent work (file names, commands, identifiers): how a misheard term is put right. */
  terms: string[] = [];
  /** Notes for the agent from ClaudeCall itself, put in front of the next message it gets. */
  notes: string[] = [];
  /** Told already this call that pictures go on the canvas by path, not as pasted data. */
  toldAboutPictures = false;
  turn = 0;
  lastSpokeAt = 0;
  lastActivity = 0;
  filler: ReturnType<typeof setTimeout> | undefined;
  chain: Promise<unknown> = Promise.resolve();
  /** Actions this agent is paused on, oldest first. It cannot go on until each is answered. */
  asks: Ask[] = [];
  /** A question this project put to the person while nobody was listening to it. */
  pendingQuestion: string | null = null;
  /** Identifies the pending question, so the page can tell when it has been answered. */
  questionId = "";
  questionAt = 0;
  /** What this agent has cost and how long it has worked, this call: the meter on its card. */
  costUsd = 0;
  busyMs = 0;
  /** When its current stretch of work began, and whether the lead was told it is taking long. */
  workSince = 0;
  toldLong = false;
  /** Snapshots of its folder before each of its recent turns, newest last: what "undo" goes back to. */
  checkpoints: Promise<Checkpoint | null>[] = [];
  /** Side questions asked mid-task and their answers, so each one has the ones before it. */
  btwHistory: { question: string; response: string }[] = [];
  /** Control tags the central agent wrote this turn, carried out once the turn ends. */
  actions: Action[] = [];
  branch = "";
  turnsDone = 0;
  sessionId = "";
  /**
   * What this agent's conversation has already been told, so the same words are not sent turn
   * after turn: the call header, and for Ada the team. Cleared when the session is new or Claude
   * Code summarises it, and then it is all told again.
   */
  told: { session: unknown; header: string; team: Map<string, string>; turns: number } | null = null;
  /** The exact model Claude Code reports this agent running, once it has said. */
  running = "";

  constructor(config: ProjectConfig, central = false) {
    this.config = config;
    this.central = central;
    this.sessionId = config.resume ?? "";
  }

  parserFor(turn: number): ReplyParser {
    // only the central agent runs the call; any agent may hand the lead over to someone else
    // only the central agent runs the call; any agent may hand the lead over, or change its own voice
    return this.parsers.get(turn) ?? this.parsers.set(turn, new ReplyParser({ actions: this.central ? undefined : ["handoff", "voice"] })).get(turn)!;
  }
}

export interface CallOptions {
  projects: ProjectConfig[];
  /** The central agent's own directory: where new projects are made, and relative paths start. */
  home: string;
  /** The shared voice prompt; each project gets it with its own identity prepended. */
  systemPrompt: string;
  /** The central agent's prompt, on top of the shared voice prompt. */
  centralPrompt: string;
  callsDir: string;
  /** Where the roster is remembered between calls. */
  rosterFile?: string;
  rewriter: Rewriter;
  send: (m: Record<string, any>) => void;
  /** The model the assistant runs on, remembered from the last call; unset for the default. */
  centralModel?: string;
  /** How the lead says her name, learned from their own voice, remembered from the last call. */
  centralAliases?: string[];
  /** How she sounds, as last set. */
  centralSound?: Sound;
  /** What Ada keeps between calls; a throwaway one when not given. */
  notebook?: Notebook;
}

const tilde = (p: string) => (p.startsWith(homedir()) ? "~" + p.slice(homedir().length) : p);
const oneLine = (s: string, max = 120) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > max ? t.slice(0, max - 1) + "…" : t;
};

/**
 * One call: the central agent, the roster of projects, and at most one of them on the line.
 *
 * The central agent (Ada) is a Claude session of her own, working in the home directory. She
 * makes and opens projects, hands them work, and moves the line between them; she does all of
 * that by writing control tags, which are carried out here when her turn ends. Projects that are
 * not on the line keep working; anything they need to tell you becomes a notification, which the
 * page holds until you have gone quiet and then reads out in her voice. So two voices never talk
 * over each other: there is only ever the central voice, or the central voice and one project.
 */
export class Call {
  private projects = new Map<string, Project>();
  private order: string[] = [];
  private focused: string = CENTRAL_ID;
  private mode: Mode = "visual";
  private opts: CallOptions;
  private central: Project;
  /** What the lead taught for the assistant's name: kept apart from the built-in spellings. */
  private learnedCentral: string[] = [];
  /** Set once the call has ended: nothing may start or wake an agent after that. */
  private closed = false;
  /** What Ada keeps between calls: see notebook.ts. */
  private notebook: Notebook;

  constructor(opts: CallOptions) {
    this.opts = opts;
    this.notebook = opts.notebook ?? new Notebook();
    this.central = new Project({
      id: CENTRAL_ID,
      name: centralName(),
      dir: opts.home,
      identity: withSound(CENTRAL, opts.centralSound),
      sound: opts.centralSound,
      // she only acts on things you ask for, while you are listening, and only inside her home
      permissionMode: "auto",
      backgroundPermissionMode: "auto",
      engagement: "pair",
      aliases: [...builtinAliases(centralName()), ...(opts.centralAliases ?? [])],
      model: opts.centralModel,
    }, true);
    this.projects.set(CENTRAL_ID, this.central);
    this.learnedCentral = opts.centralAliases ?? [];
    for (const c of opts.projects) {
      this.projects.set(c.id, new Project(c));
      this.order.push(c.id);
    }
  }

  get roster() {
    return [CENTRAL_ID, ...this.order].map((id) => this.view(id));
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  /** Begin the call with the central agent on the line, warmed so the first question is quick. */
  async start(): Promise<void> {
    await mkdir(this.opts.home, { recursive: true });
    await Promise.all(this.order.map(async (id) => {
      const p = this.projects.get(id)!;
      p.branch = await branchOf(p.config.dir);
    }));
    this.ensure(CENTRAL_ID);
    // Warm the whole team now. Starting an agent's process takes seconds; doing it while the lead
    // is still saying hello means the first thing they ask anyone is answered at full speed.
    for (const id of this.order) this.ensure(id);
    this.publish();
  }

  /** Put an agent on the line. The one leaving keeps working, quietly and more cautiously. */
  focus(id: string | null): void {
    if (this.closed) return;
    const to = id ?? CENTRAL_ID;
    if (!this.projects.has(to) || this.focused === to) return;
    const leaving = this.projects.get(this.focused);
    if (leaving) {
      // nobody is listening to approve things now, so drop it to its background mode
      leaving.session?.setPermissionMode(leaving.config.backgroundPermissionMode);
      clearTimeout(leaving.filler);
    }
    this.focused = to;
    const p = this.ensure(to);
    p.session!.setPermissionMode(p.config.permissionMode);
    p.lastActivity = Date.now();
    this.publish();
  }

  /**
   * Send a message to an agent. By default it is put on the line first; `keepFocus` leaves the
   * line where it is, which is how work is handed to a project in the background.
   */
  ask(to: string | null | undefined, text: string, ctx?: CallContext | null, { keepFocus = false, from = "", queue = false, assigned = false } = {}): void {
    if (this.closed) return;
    const id = to && this.projects.has(to) ? to : this.focused;
    if (!keepFocus) this.focus(id);
    const p = this.ensure(id);
    const onLine = this.focused === id;
    // Said while the agent is busy: the work in progress is left to finish and this is answered
    // next. Only an explicit "stop" cuts work off; talking never does.
    const queued = (queue || !!ctx?.queued) && p.session!.isBusy();
    if (ctx) ctx.queued = queued;
    if (!queued) {
      // per-turn state belongs to the running turn until it ends; a queued message must not wipe it
      p.said = [];
      p.answer = [];
      p.actions = [];
      p.lastSpokeAt = 0;
    }
    p.pendingQuestion = null;
    p.questionId = "";
    const notes = p.notes.splice(0).map((n) => `[note from ClaudeCall: ${n}]`).join(" ");
    const lead = [...this.preface(p, onLine, !!ctx?.replace), cutIn(ctx), notes, from].filter(Boolean).join(" ");
    // a snapshot of the folder before a new piece of work, so it can be undone (git folders only)
    if (!p.central && !queued) {
      p.checkpoints.push(checkpoint(p.config.dir, text.slice(0, 80), `${id}/${Date.now()}`));
      if (p.checkpoints.length > 5) p.checkpoints.shift();
    }
    const turn = p.session!.send(`${lead} ${text}`, { interrupt: !queued, replaceQueued: queued && !!ctx?.replace });
    p.turn = turn;
    if (p.state !== "working") { p.workSince = Date.now(); p.toldLong = false; }
    p.state = "working";
    p.lastActivity = Date.now();
    clearTimeout(p.filler);
    // the "one sec" filler is only for the agent you are actually listening to, and only when it
    // is starting fresh: one that is mid-task has already said what it is doing
    if (onLine && !queued) {
      p.filler = setTimeout(() => {
        if (!p.lastSpokeAt && this.focused === id) {
          p.lastSpokeAt = Date.now();
          this.emit(p, { type: "narrate", project: id, turn, text: "One sec." });
        }
      }, FILLER_MS);
    }
    // through emit, so the transcript records what the lead said, not just the replies
    this.emit(p, { type: "turn", project: id, turn, text, background: !onLine || undefined, queued: queued || undefined, assigned: assigned || undefined });
    this.publish();
  }

  /**
   * Something said to an agent that is busy. Rather than wait behind the work — which could be
   * minutes — it goes in as a side question (Claude Code's /btw): answered in a second or two from
   * what the agent already knows, while the work carries on. If it is really new work, the agent
   * says so, and it is queued as a proper follow-up, with a spoken acknowledgement right away.
   */
  async btw(id: string, text: string): Promise<void> {
    const p = this.projects.get(id);
    if (!p) return;
    if (this.closed) return;
    if (!p.session?.isBusy()) return this.ask(id, text);
    const session = p.session;
    const turn = p.turn;
    this.emit(p, { type: "btw", project: id, turn, phase: "asked", text });
    const question = [
      `[A side question from the lead, said out loud while you keep working. Do not stop your work.]`,
      text,
      ``,
      `Reply in one to three short spoken sentences: plain words, no markdown, no code, no file paths. If the lead asks for a full summary or for detail, give all of it instead, still in short spoken sentences.`,
      `If answering properly needs you to do or change something — run a command, edit a file, start new work — reply with exactly "QUEUE:" followed by a few words saying you will do it as soon as your current task is done.`,
    ].join("\n");
    let answer = "";
    try {
      answer = await session.sideQuestion(question, p.btwHistory);
    } catch (e: any) {
      answer = "QUEUE: I'll get to that as soon as I've finished this.";
      console.warn(`side question to ${p.config.name} failed: ${e.message}`);
    }
    // parked, replaced or hung up on while it was asked: it must not be woken up to answer
    if (this.closed || p.session !== session) return;
    // agents are used to wrapping speech in <say>: keep what is inside, drop any <screen> part
    const said = [...answer.matchAll(/<say>([\s\S]*?)(?:<\/say>|$)/g)].map((m) => m[1].trim()).join(" ");
    answer = (said || answer).replace(/<screen>[\s\S]*?(<\/screen>|$)/g, " ").replace(/<\/?[a-z]+>/g, " ").replace(/\s+/g, " ").trim();
    p.btwHistory = [...p.btwHistory, { question: text, response: answer }].slice(-6);
    const queued = /^\s*QUEUE:?\s*([\s\S]*)$/i.exec(answer);
    if (queued) {
      // new work: it waits behind the current task, nothing is interrupted
      this.ask(id, text, { kind: "followup", working: true, queued: true }, { keepFocus: true, queue: true });
    }
    // not clipped: a short answer is short anyway, and a full summary the lead asked for is wanted whole
    const spoken = clean(queued ? queued[1].trim() || "I'll do that as soon as I've finished this." : answer, this.mode);
    if (spoken) this.emit(p, { type: "btw", project: id, turn, phase: "answer", text: spoken, queued: !!queued || undefined, spoken: this.focused === id });
  }

  /** Something the person said for a project that is not on the line, passed on without moving it. */
  tell(id: string, text: string): boolean {
    const p = this.projects.get(id);
    if (!p || p.central) return false;
    if (p.state === "parked") p.state = "cold";
    this.ask(id, text, null, { keepFocus: true, queue: true, from: `[the person says this to you through ${centralName()}; reply in one short sentence]` });
    return true;
  }

  interrupt(id: string | null = this.focused): void {
    const p = id ? this.projects.get(id) : null;
    if (!p) return;
    clearTimeout(p.filler);
    p.session?.stop();
  }

  /**
   * Say yes to what an agent is paused on. The agent was waiting on this exact request, so it
   * simply carries on: no retry, no lost context. `always` also takes the CLI's own suggestion
   * for this session, so the same kind of action is not asked about again. With several asks
   * waiting, the oldest is answered unless a request id is named.
   */
  grant(id: string, scope: "once" | "always" = "once", requestId?: string, answers?: Record<string, string>): boolean {
    return this.settle(id, true, scope === "always", requestId, { answers });
  }

  /**
   * Say no. The agent is told, and carries on without it or stops and says what is left. A
   * message replaces the stock refusal: "keep planning, and use Postgres" on a plan, say.
   */
  deny(id: string, requestId?: string, message = ""): boolean {
    return this.settle(id, false, false, requestId, { message });
  }

  private settle(id: string, allow: boolean, always: boolean, requestId?: string, { answers, message = "" }: { answers?: Record<string, string>; message?: string } = {}): boolean {
    const p = this.projects.get(id);
    if (!p?.session) return false;
    const ask = requestId ? p.asks.find((a) => a.requestId === requestId) : p.asks[0];
    if (!ask) return false;
    p.asks = p.asks.filter((a) => a !== ask);
    let ok = true;
    if (ask.retry) {
      // refused earlier and already worked around: allow exactly this, then have it tried again
      if (allow) {
        p.session.allow(ask.retry);
        this.ask(id, `[the lead allowed this out loud: ${ask.detail || ask.phrase}] It was refused before and is allowed now, exactly as it was. Try it again, then carry on.`, null, { keepFocus: true, queue: true });
      }
    } else {
      // picked answers to the agent's own questions travel back inside the tool's input
      const input = answers && ask.tool === "AskUserQuestion" ? { ...(ask.input as object), answers } : ask.input;
      ok = p.session.answer(ask.requestId, allow, { always, suggestions: ask.suggestions, input, message });
    }
    if (p.state === "blocked" && !p.asks.length) p.state = "working";
    this.emit(p, { type: "answered", project: id, requestId: ask.requestId, allow, always: always || undefined, phrase: ask.phrase });
    this.publish();
    return ok;
  }

  /**
   * The picture an agent most likely meant, when what it put on the canvas was the picture itself
   * pasted in as text and cut off on the way (models cannot copy thousands of base64 characters
   * reliably). Its recent work names the file it was turning into text; that file is shown
   * instead, and the agent is told once, with its next message, how to show pictures.
   */
  async rescueImage(id: string): Promise<string | null> {
    const p = this.projects.get(id);
    if (!p) return null;
    const { stat } = await import("node:fs/promises");
    const { isAbsolute, resolve } = await import("node:path");
    for (const path of p.images) {
      const file = isAbsolute(path) ? path : resolve(p.config.dir, path.replace(/^~(?=$|\/)/, homedir()));
      if ((await stat(file).catch(() => null))?.isFile()) {
        if (!p.toldAboutPictures) {
          p.toldAboutPictures = true;
          p.notes.push(`a picture you pasted onto the canvas as base64 text was cut off on the way, so ${path} from your recent work was shown in its place. The canvas reads files itself: show a picture with ![what it is](its/path), never as base64 or a data: URL.`);
        }
        return file;
      }
    }
    return null;
  }

  /**
   * What the clean-up pass needs to put right what the lead said to an agent: everyone's names and
   * the spellings they answer to, the words of that agent's recent work, and what it just said.
   */
  hearingContext(id: string): HearingContext {
    const p = this.projects.get(id) ?? this.projects.get(this.focused)!;
    return {
      to: p.config.name,
      team: [...this.projects.values()].flatMap((o) => [o.config.name, ...(o.config.aliases ?? []).slice(0, 4)]),
      terms: [p.config.dir.split("/").pop() ?? "", ...p.terms].filter(Boolean).slice(0, 30),
      agentLastSaid: p.said.slice(-3),
    };
  }

  /** The folder an agent works in, where a relative path in its markdown starts; null if unknown. */
  dirOf(id: string): string | null {
    return this.projects.get(id)?.config.dir ?? null;
  }

  /**
   * Put the lead through from one agent to another, with a note saying why: "Iris, connect me to
   * Ada and ask her to switch me to Juno". The one receiving them greets them, says what it
   * understood, and checks before acting, offering to send them back if this was a mistake.
   * `byLead`: the lead asked the page directly, rather than the agent passing them on.
   */
  handoff(fromId: string, to: string, note: string, { byLead = false } = {}): string | null {
    const from = this.projects.get(fromId);
    const target = this.find(to);
    if (!target) return `There is no one called "${to}" on the call.`;
    if (!from || target === from) return null;
    // the page speaks no handover line of its own: the one receiving them does the greeting
    this.opts.send({ type: "handoff", from: fromId, to: target.config.id, note });
    this.focus(target.config.id);
    const who = from.config.name;
    const said = note ? `"${note}"` : "nothing more than that they wanted you";
    const brief = byLead
      ? `[The lead was talking with ${who} and asked to be put through to you, adding: ${said}.]`
      : `[${who} has put the lead through to you, with this note: ${said}.]`;
    const instructions = [
      brief,
      `Greet them in your own voice and name yourself, in one short sentence ("Hi, it's ${target.config.name}").`,
      `Say in a few words what you understood they want, and ask them to confirm before you act on it.`,
      `Add that if this was a mistake you can put them back through to ${who}.`,
      target.central ? `When they confirm, do it with your usual tags; if they want to go back, switch them to ${who}.` : `If they want to go back to ${who}, say so and hand them back with <handoff to="${who}"></handoff>.`,
    ].join(" ");
    // A busy agent greets them through a side question, so its work is not cut off; an idle one
    // takes it as a normal turn.
    if (target.session?.isBusy()) this.btw(target.config.id, instructions).catch((e) => console.error(e));
    else this.ask(target.config.id, instructions);
    return null;
  }

  /**
   * How the lead's voice comes out when they say an agent's name, captured by having them say it
   * a few times. Kept as that agent's aliases, so it is matched as exactly as the name itself.
   * Spellings that are already someone else's name or alias are dropped. Returns what was kept.
   */
  teach(id: string, heard: string[]): string[] {
    const p = this.projects.get(id);
    if (!p) return [];
    const others = [...this.projects.values()].filter((o) => o !== p).flatMap((o) => [o.config.name, ...(o.config.aliases ?? [])].map((n) => n.toLowerCase()));
    const own = p.config.name.toLowerCase();
    const kept = (aliasesOf(heard) ?? []).filter((a) => a !== own && !others.includes(a));
    if (p.central) {
      this.learnedCentral = [...new Set([...this.learnedCentral, ...kept])].slice(-12);
      p.config.aliases = [...builtinAliases(p.config.name), ...this.learnedCentral];
    } else p.config.aliases = [...new Set([...(p.config.aliases ?? []), ...kept])].slice(-12);
    this.remember();
    this.publish();
    return kept;
  }

  /** Everyone's name on the call, the assistant's first; `except` leaves one agent out. */
  private names(except?: string): string[] {
    return [...this.projects.values()].filter((p) => p.config.id !== except).map((p) => p.config.name);
  }

  /** Why a name will not do, in words for the lead or the assistant; null when it is fine. */
  private nameProblem(name: string, except?: string): string | null {
    const clean = name.trim();
    if (!/^[A-Za-z][A-Za-z']{1,19}$/.test(clean)) return `"${clean}" will not work as a name: use one word, letters only, easy to say.`;
    const others = this.names(except);
    const taken = others.find((o) => o.toLowerCase() === clean.toLowerCase());
    const clash = taken ?? confusable(clean, others);
    if (!clash) return null;
    const suggest = clearName("Otto", others); // any name that clashes, so a spare comes back
    return taken
      ? `${taken} is already on the call. Pick another name, for example ${suggest}.`
      : `"${clean}" sounds too much like ${clash}, so the two would be hard to tell apart by voice. Pick another name, for example ${suggest}.`;
  }

  /**
   * Give an agent a new name. Its id, folder, conversation and colour stay; only what you call it
   * changes, and the agent is told. Returns a problem in words when the name will not do.
   */
  rename(id: string, name: string): string | null {
    const p = this.projects.get(id);
    if (!p) return "There is no one by that name to rename.";
    const problem = this.nameProblem(name, id);
    if (problem) return problem;
    const old = p.config.name;
    const clean = name.trim();
    p.config.name = clean[0].toUpperCase() + clean.slice(1);
    if (p.central) {
      // her id stays; her name, its common mishearings, and what the lead taught for the old one change
      setCentralName(p.config.name);
      this.learnedCentral = [];
      p.config.aliases = builtinAliases(p.config.name);
      this.remember();
      this.publish();
      this.opts.send({ type: "central", identity: p.config.identity, name: p.config.name, id: CENTRAL_ID, home: this.opts.home });
      this.ask(id, `[the lead has renamed you from ${old} to ${p.config.name}. You are ${p.config.name} from now on; introduce yourself that way. Reply with one short sentence.]`, null, { keepFocus: true, queue: true });
      return null;
    }
    p.config.aliases = undefined; // spellings of the old name no longer apply
    this.remember();
    this.publish();
    this.ask(id, `[${centralName()}: the lead has renamed you from ${old} to ${p.config.name}. Answer to ${p.config.name} from now on. Reply with one short sentence.]`, null, { keepFocus: true, queue: true });
    return null;
  }

  /**
   * Put an agent on a different model, from its next turn, without losing its conversation. An
   * empty or unknown name goes back to the default (DEFAULT_MODEL). Remembered for the next call.
   */
  setModel(id: string, model: string): boolean {
    const p = this.projects.get(id);
    if (!p) return false;
    p.config.model = modelOf(model);
    p.session?.setModel(p.config.model ?? DEFAULT_MODEL);
    this.remember();
    this.publish();
    return true;
  }

  /**
   * What undoing an agent's last turn would change: the files that differ from the snapshot taken
   * before it. Empty when nothing has changed, null when there is no snapshot to go back to.
   */
  async undoPreview(id: string): Promise<{ files: string[]; label: string } | null> {
    const p = this.projects.get(id);
    const cp = p ? await this.lastCheckpoint(p) : null;
    if (!cp) return null;
    return { files: (await changedSince(cp)).map((c) => c.file), label: cp.label };
  }

  /**
   * Undo an agent's last turn: stop it, put its folder back as the snapshot had it, and tell it so,
   * so it does not quietly do the same work again. Returns the files put back, or null.
   */
  async undo(id: string): Promise<string[] | null> {
    const p = this.projects.get(id);
    if (!p || p.central) return null;
    const cp = await this.lastCheckpoint(p);
    if (!cp) return null;
    p.session?.stop();
    const files = await restore(cp);
    p.checkpoints.pop();
    p.notes.push(`The lead undid your last piece of work ("${cp.label}"): ${files.length ? `${files.join(", ")} ${files.length === 1 ? "is" : "are"} back as before` : "nothing had changed"}. Do not redo it unless they ask.`);
    this.emit(p, { type: "undone", project: id, files, label: cp.label });
    this.publish();
    return files;
  }

  private async lastCheckpoint(p: Project): Promise<Checkpoint | null> {
    for (let i = p.checkpoints.length - 1; i >= 0; i--) { const cp = await p.checkpoints[i]; if (cp) return cp; }
    return null;
  }

  /** Release a project's process, keeping its session id so it can be resumed where it left off. */
  park(id: string): void {
    const p = this.projects.get(id);
    if (!p || p.central) return;
    clearTimeout(p.filler);
    p.session?.close();
    p.session = null;
    p.parsers.clear();
    p.state = "parked";
    // nothing can be granted to an agent that is not running: let its requests and question go
    p.asks = [];
    p.pendingQuestion = null;
    p.questionId = "";
    if (this.focused === id) this.focused = CENTRAL_ID;
    this.publish();
  }

  /**
   * Is anyone still at work, or waiting on the lead? Then hanging up does not end the call: the
   * team keeps going with nobody listening, and the lead is briefed when they are back.
   */
  busy(): boolean {
    return [...this.projects.values()].some((p) => p.state === "working" || !!p.session?.isBusy() || p.asks.length > 0 || !!p.pendingQuestion);
  }

  /** Where the call's messages go: the lead's page, or a buffer while nobody is on the call. */
  setSend(send: (m: Record<string, any>) => void): void {
    this.opts.send = send;
  }

  /** Put everyone back on the page after the lead rejoins: the roster as it stands now. */
  republish(): void {
    this.publish();
  }

  /**
   * Change how an agent sounds — from the settings, from Ada, or from the agent itself. Applied
   * from its next sentence, kept with the roster so it lasts, and shown on every page at once.
   */
  setSound(id: string, patch: Sound): boolean {
    const p = this.projects.get(id);
    const clean = soundOf(patch);
    if (!p || !clean) return false;
    p.config.sound = { ...(p.config.sound ?? {}), ...clean };
    p.config.identity = withSound(p.config.identity, clean);
    this.remember();
    this.publish();
    return true;
  }

  /** Take a project off the roster altogether. Its folder and its conversation stay on disk. */
  remove(id: string): void {
    const p = this.projects.get(id);
    if (!p || p.central) return;
    this.park(id);
    this.notebook.log(`closed ${p.config.name}`);
    this.notebook.status(p.config.name, null);
    this.projects.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.publish();
    this.remember();
  }

  async close(): Promise<void> {
    this.closed = true;
    for (const p of this.projects.values()) {
      clearTimeout(p.filler);
      p.session?.close();
      p.session = null;
    }
    await Promise.all([...this.projects.values()].map((p) => p.transcript?.close()));
  }

  // ---------- the central agent's actions ----------

  /** Find a project by id or by its spoken name, forgiving case and punctuation. */
  private find(ref: string | undefined): Project | null {
    const k = (ref ?? "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    if (!k) return null;
    return this.projects.get(k) ?? [...this.projects.values()].find((p) => p.config.name.toLowerCase() === k) ?? null;
  }

  /**
   * Carry out what the central agent asked for, in order. What succeeds shows on the roster and
   * the page announces it; what cannot be done goes back to her, so she can explain or ask.
   */
  private async act(actions: Action[]): Promise<void> {
    const problems: string[] = [];
    for (const a of actions) {
      try {
        const problem = await this.perform(a);
        if (problem) problems.push(problem);
      } catch (e: any) {
        problems.push(`${a.text.slice(0, 80)} failed: ${e.message}`);
      }
    }
    // queued: the lead may have asked her something else meanwhile, and that must not be cut off
    if (problems.length) this.ask(CENTRAL_ID, `[result of your actions] ${problems.join(" ")}`, null, { keepFocus: true, queue: true });
  }

  private async perform(a: Action): Promise<string | null> {
    const { attrs, body } = a;
    switch (a.name) {
      case "voice": {
        // how an agent sounds: its voice, speed, pitch, loudness, side — or Ada's own
        const p = attrs.to ? this.find(attrs.to) : this.central;
        if (!p) return `There is no one called "${attrs.to}" to change.`;
        this.setSound(p.config.id, voicePatch(attrs, p.config.identity));
        return null;
      }
      case "call":
        // the call itself: hang up, hold, pause, or mute the lead. The page does it, after she has spoken
        if (!/^(end|hold|pause|mute)$/.test(attrs.do ?? "")) return `"${attrs.do}" is not something I can do to the call: end, hold, pause or mute.`;
        this.opts.send({ type: "call-control", do: attrs.do });
        return null;
      case "setting":
        // an app setting on the lead's page: chimes, the ring, stereo voices, audio only, and so on
        if (!attrs.name) return "The setting tag needs a name.";
        this.opts.send({ type: "app-setting", name: attrs.name, value: attrs.value ?? "" });
        return null;
      case "remember":
        // something the lead wants kept beyond this call: a preference, a decision
        if (!body.trim()) return "The remember tag had nothing in it.";
        this.notebook.remember(body);
        return null;
      case "forget":
        if (!this.notebook.forget(body)) return `Nothing remembered mentions "${body.trim()}".`;
        return null;
      case "switch": {
        const p = this.find(attrs.to);
        if (!p) return `There is no project called "${attrs.to}".`;
        this.focus(p.config.id);
        return null;
      }
      case "delegate": {
        const p = this.find(attrs.to);
        if (!p || p.central) return `There is no project called "${attrs.to}" to hand that to.`;
        if (!body) return `The delegate tag for ${p.config.name} had no task in it.`;
        if (p.state === "parked") p.state = "cold";
        this.assign(p, body, attrs.focus === "true");
        this.notebook.log(`gave ${p.config.name}: ${body}`);
        return null;
      }
      case "park": {
        const p = this.find(attrs.to);
        if (!p || p.central) return `There is no project called "${attrs.to}" to park.`;
        this.park(p.config.id);
        return null;
      }
      case "close": {
        const p = this.find(attrs.to);
        if (!p || p.central) return `There is no project called "${attrs.to}" to close.`;
        this.remove(p.config.id);
        return null;
      }
      case "new": {
        const folder = (attrs.folder || attrs.name || "").trim().replace(/[^\w.\- ]+/g, "").replace(/\s+/g, "-");
        if (!folder) return "A new project needs a folder or a name.";
        const dir = join(this.opts.home, folder);
        await mkdir(dir, { recursive: true });
        if (body) await this.writeBrief(dir, attrs.name || folder, body);
        return this.adopt(dir, { name: attrs.name, resume: false, brief: body, focus: attrs.focus, prompt: attrs.prompt, model: attrs.model });
      }
      case "open": {
        const found = await resolveDir(attrs.path ?? "", this.opts.home);
        if (found.kind === "empty") return "The open tag had no path.";
        if (found.kind === "ambiguous") return `"${attrs.path}" matches several folders: ${found.options!.map(tilde).join(", ")}. Ask the person which one, then open it by its full path.`;
        if (found.kind === "missing") return `No folder matching "${attrs.path}" was found${found.dir ? ` (${tilde(found.dir)} does not exist)` : ""}. Ask the person where it is, or offer to make a new project.`;
        const resume = attrs.resume === "new" ? false : attrs.resume === "last" ? true : attrs.resume || undefined;
        return this.adopt(found.dir!, { name: attrs.name, resume, brief: body, focus: attrs.focus, prompt: attrs.prompt, model: attrs.model });
      }
    }
    return null;
  }

  /**
   * Add a folder to the roster and give it an agent. With a brief, the agent starts on it at
   * once, in the background unless asked otherwise; without one, it is put on the line.
   * `resume`: undefined to find out, false for a fresh session, true for the latest, or an id.
   */
  private async adopt(dir: string, o: { name?: string; resume?: string | boolean; brief?: string; focus?: string; prompt?: string; model?: string }): Promise<string | null> {
    const existing = [...this.projects.values()].find((p) => !p.central && p.config.dir === dir);
    if (existing) {
      if (existing.state === "parked") existing.state = "cold";
      if (o.brief) this.assign(existing, o.brief, o.focus === "true");
      else this.focus(existing.config.id);
      return null;
    }
    let resume: string | undefined;
    if (o.resume === undefined || o.resume === true) {
      const sessions = await findSessions(dir);
      if (sessions.length && o.resume === undefined) {
        const list = sessions.slice(0, 3).map((s, i) => `(${i + 1}) ${ago(s.at)}${s.label ? `: "${oneLine(s.label, 60)}"` : ""} [id ${s.id}]`).join("; ");
        return `${tilde(dir)} has ${sessions.length} earlier Claude conversation${sessions.length > 1 ? "s" : ""}: ${list}. Ask the person whether to pick up the latest or start fresh, then open it again with resume="last", resume="new" or resume="<id>".`;
      }
      resume = sessions[0]?.id;
    } else if (typeof o.resume === "string") resume = o.resume;

    // a name asked for by name must be clear of everyone else's; one taken from the folder is
    // quietly swapped for a clear one instead
    if (o.name) {
      const problem = this.nameProblem(o.name);
      if (problem) return problem;
    }
    const config = projectFor(dir, this.order.length, this.order, { ...(o.name ? { name: o.name } : {}), ...(o.prompt ? { prompt: o.prompt } : {}), ...(o.model ? { model: o.model } : {}) }, this.names());
    config.resume = resume;
    const p = new Project(config);
    p.branch = await branchOf(dir);
    this.projects.set(config.id, p);
    this.order.push(config.id);
    this.opts.send({ type: "opened", project: config.id, name: config.name, dir, resumed: resume ?? null, identity: config.identity });
    this.notebook.log(`${o.brief ? "set up" : "opened"} ${config.name} in ${tilde(dir)}${o.brief ? `, to: ${o.brief}` : ""}`);
    this.remember();
    if (o.brief) this.assign(p, o.brief, o.focus === "true");
    else {
      this.focus(config.id);
      this.ensure(config.id); // warm it now, so the first question does not wait on a cold start
    }
    return null;
  }

  /** Hand a project a task from the central agent. */
  private assign(p: Project, brief: string, focus: boolean): void {
    this.ask(p.config.id, brief, null, {
      keepFocus: !focus,
      queue: true,
      from: `[a task from ${centralName()}, on the person's behalf]`,
      assigned: true,
    });
  }

  /**
   * A new project's mission, kept in its folder. The agent reads it on every start, so a project
   * picked up in a later call still knows what it is for — and so does anyone who opens the folder.
   */
  private async writeBrief(dir: string, name: string, brief: string): Promise<void> {
    const file = join(dir, "BRIEF.md");
    const had = await readFile(file, "utf8").catch(() => "");
    const entry = `## ${new Date().toISOString().slice(0, 10)} — from ${centralName()}\n\n${brief.trim()}\n`;
    await writeFile(file, had ? `${had.trimEnd()}\n\n${entry}` : `# ${name}\n\nWhat this project is for, as handed out by ${centralName()}. Newest last.\n\n${entry}`);
  }

  /**
   * Make or open a project straight from the page, without a model in the loop: the form on the
   * screen is exact, so there is nothing for the central agent to interpret. Returns a problem
   * to show, or null.
   */
  async create(o: { name?: string; folder?: string; path?: string; brief?: string; focus?: boolean; prompt?: string; model?: string }): Promise<string | null> {
    const attrs: Record<string, string> = {};
    if (o.name) attrs.name = o.name;
    if (o.model) attrs.model = o.model;
    if (o.prompt) attrs.prompt = o.prompt;
    if (o.focus) attrs.focus = "true";
    if (o.path) {
      attrs.path = o.path;
      attrs.resume = "last";
      return this.perform({ kind: "action", name: "open", attrs, body: o.brief ?? "", text: "" });
    }
    attrs.folder = o.folder || o.name || "";
    return this.perform({ kind: "action", name: "new", attrs, body: o.brief ?? "", text: "" });
  }

  /** Each project in a line, as Ada is told it: who is on the call and how they are. */
  private team(): Map<string, string> {
    const lines = new Map<string, string>();
    for (const id of this.order) {
      const p = this.projects.get(id)!;
      const where = this.focused === id ? "on the line" : p.state === "working" ? "working in the background" : p.state === "parked" ? "parked" : p.state === "cold" ? "not started" : "idle";
      const bits = [`${p.config.name} (id ${id}) in ${tilde(p.config.dir)}: ${where}`];
      if (p.asks.length) bits.push(`paused, waiting for the person to allow: ${p.asks.map((a) => a.phrase).join("; ")}`);
      if (p.pendingQuestion) bits.push(`asked: "${oneLine(p.pendingQuestion)}"`);
      if (p.report) bits.push(`last said: "${oneLine(p.report)}"`);
      lines.set(id, bits.join(", "));
    }
    return lines;
  }

  /** Who is waiting on the lead, as a pseudo-entry of the team so a change in it shows up too. */
  private waiting(): string {
    const names = this.order.map((id) => this.projects.get(id)!).filter((p) => p.asks.length || p.pendingQuestion).map((p) => p.config.name);
    return `waiting on the lead: ${names.length ? names.join(", ") : "nobody"}`;
  }

  /**
   * What goes in front of a message so the agent knows where things stand — only what it has not
   * been told already. A new conversation (or one Claude Code just summarised) gets everything:
   * the call header, and for Ada the whole team and her notebook from earlier calls. After that
   * the header comes again only when it changes, and Ada hears only what changed on the team.
   * The whole team is told again every so often anyway, so nothing drifts.
   */
  private preface(p: Project, onLine: boolean, replacing: boolean): string[] {
    const fresh = !p.told || p.told.session !== p.session;
    if (fresh) p.told = { session: p.session, header: "", team: new Map(), turns: 0 };
    const told = p.told!;
    const out: string[] = [];
    const header = callHeader(this.mode, onLine);
    // a message that replaces a queued one may be replacing the one that carried the header
    if (header !== told.header || replacing) out.push(header);
    told.header = header;
    if (p.central) {
      const now = this.team();
      now.set("\u0000waiting", this.waiting());
      if (fresh || told.turns % 15 === 0) {
        if (fresh) out.push(this.notebook.text());
        const lines = [...now].filter(([id]) => id !== "\u0000waiting").map(([, d]) => d);
        out.push(`[projects: ${lines.length ? lines.join("; ") : "none yet"}] [${this.waiting()}; the page tracks these and reads them out when the lead asks]`);
      } else out.push(teamChanges(told.team, now));
      told.team = now;
    }
    told.turns++;
    return out.filter(Boolean);
  }

  // ---------- internals ----------

  private view(id: string) {
    const p = this.projects.get(id)!;
    return {
      id,
      name: p.config.name,
      model: p.config.model ?? "",
      running: p.running || undefined,
      aliases: p.config.aliases ?? [],
      dir: p.config.dir,
      central: p.central || undefined,
      branch: p.branch,
      state: p.state,
      focused: this.focused === id,
      engagement: p.config.engagement,
      permissionMode: p.session ? p.session.mode : p.config.permissionMode,
      waiting: p.asks[0]?.phrase ?? null,
      asks: p.asks.map((a) => ({ requestId: a.requestId, tool: a.tool, phrase: a.phrase, detail: a.detail, reason: a.reason, at: a.at, risk: a.risk })),
      sessionId: p.sessionId || null,
      resumed: !!p.config.resume,
      canUndo: p.checkpoints.length > 0 || undefined,
      costUsd: +p.costUsd.toFixed(4),
      busyMs: p.busyMs,
      prompt: p.config.prompt ?? null,
      question: p.pendingQuestion,
      questionId: p.questionId || null,
      // how long this agent has been waiting on the lead, for ordering the queue
      waitingSince: p.asks[0]?.at ?? (p.pendingQuestion ? p.questionAt : null),
      report: p.report,
      turn: p.turn,
      turns: p.turnsDone,
      identity: p.config.identity,
    };
  }

  private publish(): void {
    this.opts.send({ type: "roster", projects: this.roster, focused: this.focused });
  }

  /** Write the roster down, so the projects are still there on the next call. */
  private remember(): void {
    if (!this.opts.rosterFile) return;
    const list = this.order.map((id) => {
      const p = this.projects.get(id)!;
      return { name: p.config.name, dir: p.config.dir, sessionId: p.sessionId || undefined, prompt: p.config.prompt, aliases: p.config.aliases, model: p.config.model, sound: p.config.sound };
    });
    saveRoster(this.opts.rosterFile, list, { model: this.central.config.model, name: this.central.config.name === CENTRAL_DEFAULT ? undefined : this.central.config.name, aliases: this.learnedCentral, sound: this.central.config.sound }).catch((e) => console.error("Could not save the roster:", e.message));
  }

  /** The per-project half of the voice prompt: who it is, and that it is not alone. */
  private preamble(p: Project): string {
    if (p.central) return this.opts.centralPrompt.replaceAll("{{NAME}}", centralName());
    const others = this.order.filter((id) => id !== p.config.id).map((id) => this.projects.get(id)!.config.name);
    const lines = [
      `# Who you are on this call`,
      ``,
      `You are **${p.config.name}**, a member of the lead's team. Your project is the folder \`${p.config.dir}\`, and you are its own agent, with your own conversation.`,
      ``,
      `This is a live team meeting. The person on the call is **the lead**: they run the team, and they talk to one of you at a time. ${centralName()} is the lead's assistant: she sets projects up, hands out work on the lead's behalf, switches the lead between you, and keeps track of who needs the lead's input. She does not manage you and does not read your work.`,
      others.length
        ? `Your teammates are ${others.join(", ")}. Speak only for your own project; if the lead asks about another one, say it is not yours and that ${centralName()} can put them through.`
        : `You are the only project on the team so far.`,
      ``,
      `## When you have the floor`,
      `Each message says whether you are on the line. On the line, the lead is talking with you right now and everything in \`<say>\` is spoken aloud in your own voice. Talk like a teammate in a meeting: lead with the point, keep it short, and end with a clear ask or hand-back. ${p.config.engagement === "delegate" ? "You are in delegate mode: one line when you start and one when you finish, no running commentary." : "Give brief updates while you work, as the voice guide describes."}`,
      ``,
      `## When you are in the background`,
      `The lead is talking with someone else. Nothing you say is spoken. Work quietly. When you finish, make your final \`<say>\` one sentence that stands alone as your report: ${centralName()} will offer it to the lead when they are free.`,
      `Only if you truly cannot go on without a decision from the lead, put one short, self-contained question in \`<question>…</question>\` and stop. It waits in the lead's queue; you get the answer as your next message. Do not ask about things you can reasonably decide yourself.`,
      ``,
      `## Work and permission`,
      `A message starting \`[a task from ${centralName()}, on the person's behalf]\` is work from the lead, passed on by ${centralName()}. Do it as if the lead had asked you directly.`,
      `Ordinary work goes ahead on its own. Anything the safety check judges risky pauses you until the lead answers; ${centralName()} brings it to them. Just wait, and carry on when it goes through. If the answer is no, carry on without it, or stop and say what is left undone. Never try to work around a refusal.`,
      `If your folder has a \`BRIEF.md\`, it is your mission: read it when you start, and keep to it.`,
      `If the lead asks you to sound different — slower, faster, louder, quieter, another voice, the other side — change it yourself with \`<voice speed="slower"/>\` (attributes: \`name\` a system voice such as Daniel or Karen, \`speed\` a number around 1 or faster/slower, \`volume\` 0–1 or louder/quieter, \`side\` left, right or centre). It changes only your own voice, from your next sentence.`,
      ``,
      `## The canvas`,
      `Whatever you put in \`<screen>\` appears on a canvas beside the call. To show a picture, GIF or video, write \`![what it is](path/or/link)\` with the file's path (relative to your folder, or absolute) or a web link: the canvas reads the file itself. Never paste an image as base64 or a \`data:\` URL; it gets cut off and never shows.`,
      ``,
      `## Putting the lead through`,
      `If the lead asks you to put them through to ${centralName()} or to another agent ("connect me to ${centralName()} and ask her to…"), say so in one short \`<say>\` ("Putting you through to ${centralName()}.") and end your reply with \`<handoff to="${centralName()}">what they want, in one line</handoff>\`. Whoever you hand them to reads the note, greets them and checks with them first. Do not do the thing yourself.`,
      ...(p.config.prompt ? [``, `## The lead's instructions for you`, p.config.prompt] : []),
    ];
    return lines.join("\n");
  }

  private ensure(id: string): Project {
    const p = this.projects.get(id)!;
    if (p.session) return p;
    // one transcript per agent per call, opened once: waking a parked agent continues it
    if (!p.transcript) {
      p.transcript = new Transcript(this.opts.callsDir, p.config.name);
      p.transcript.open({ project: p.config.name, cwd: p.config.dir, branch: p.branch, permissionMode: p.config.permissionMode });
    }
    const session = new ClaudeSession({
      cwd: p.config.dir,
      systemPrompt: `${this.preamble(p)}\n\n${this.opts.systemPrompt}`,
      permissionMode: this.focused === id ? p.config.permissionMode : p.config.backgroundPermissionMode,
      resume: p.sessionId || undefined,
      model: p.config.model ?? DEFAULT_MODEL,
    });
    session.on((turn, ev) => this.onEvent(p, turn, ev));
    session.start();
    p.session = session;
    p.state = "warm";
    return p;
  }

  /** Events arrive out of a worker and go out in order, because cleaning speech is async. */
  private onEvent(p: Project, turn: number, ev: any): void {
    p.chain = p.chain.then(() => this.handle(p, turn, ev)).catch((e) => console.error(e));
  }

  private emit(p: Project, m: Record<string, any>): void {
    p.transcript?.log(m);
    this.opts.send(m);
  }

  private async say(p: Project, turn: number, text: string): Promise<void> {
    const s = clean(await this.opts.rewriter.toSpeech(text), this.mode);
    if (!s) return;
    p.said.push(s);
    p.answer.push(s);
    p.lastSpokeAt = Date.now();
    clearTimeout(p.filler);
    // the page decides whether this is spoken: only the agent on the line has a voice
    this.emit(p, { type: "say", project: p.config.id, turn, text: s, spoken: this.focused === p.config.id });
  }

  private async parsed(p: Project, turn: number, events: ParsedEvent[]): Promise<void> {
    const id = p.config.id;
    for (const e of events) {
      if (e.kind === "sentence") await this.say(p, turn, e.text);
      else if (e.kind === "screen") this.emit(p, { type: "screen", project: id, turn, text: e.text });
      else if (e.kind === "aside") this.emit(p, { type: "aside", project: id, turn, text: e.text });
      else if (e.kind === "question") p.pendingQuestion = e.text;
      else if (e.kind === "action") {
        // only the central agent runs the call; from a project, a tag like this is just text
        if (p.central) { p.actions.push(e); this.emit(p, { type: "action", project: id, turn, name: e.name, attrs: e.attrs, body: e.body }); }
        else if (e.name === "voice") {
          // an agent may change how it sounds — its own voice only, never anyone else's
          this.setSound(id, voicePatch(e.attrs, p.config.identity));
          this.emit(p, { type: "action", project: id, turn, name: e.name, attrs: e.attrs, body: e.body });
        } else if (e.name === "handoff") {
          // any agent can put the lead through to someone else; it happens when its turn ends
          p.handoff = { to: e.attrs.to || centralName(), note: e.body.trim() };
          this.emit(p, { type: "action", project: id, turn, name: e.name, attrs: e.attrs, body: e.body });
        } else this.emit(p, { type: "aside", project: id, turn, text: e.text });
      } else {
        // no <say> at all: speak the opening of the reply and put the whole thing on screen
        const parts = clean(e.text, this.mode).match(/[^.!?]+[.!?]*/g) ?? [];
        for (const s of parts.slice(0, 2)) await this.say(p, turn, s.trim());
        if (parts.length > 2) this.emit(p, { type: "screen", project: id, turn, text: e.text });
      }
    }
  }

  /**
   * News for the lead. Only what needs their reply — a permission, a question — is marked so; the
   * page queues and announces only that, and shows the rest (finished, failed, taking a while) on
   * the agent's card. The central agent never reports on herself in the third person ("Ada has
   * news"): her own results are on her card, and only her questions and permissions go out.
   */
  private queue(n: Notification): void {
    const needsReply = n.kind === "permission" || n.kind === "question";
    if (n.project === CENTRAL_ID && !needsReply) return;
    this.opts.send({ type: "notify", ...n, needsReply: needsReply || undefined });
  }

  private async handle(p: Project, turn: number, ev: any): Promise<void> {
    const id = p.config.id;
    const onLine = this.focused === id;
    switch (ev.kind) {
      case "text":
        await this.parsed(p, turn, p.parserFor(turn).feed(ev.text));
        break;
      case "thinking":
        this.emit(p, { type: "thinking", project: id, turn, text: ev.text });
        break;
      case "tool": {
        // a long stretch of work gets one gentle word to the lead, who may want to check in
        if (!p.central && !p.toldLong && p.workSince && Date.now() - p.workSince > LONG_WORK_MS) {
          p.toldLong = true;
          this.queue(notification("long", p.config.name, id, { minutes: Math.round((Date.now() - p.workSince) / 60000) }));
        }
        p.answer = []; // still working: what it says next is the answer
        rememberImages(p, JSON.stringify(ev.input ?? ""));
        rememberTerms(p, ev.input);
        this.emit(p, { type: "tool", project: id, turn, id: ev.id, label: toolLabel(ev.name, ev.input), detail: toolDetail(ev.name, ev.input) });
        const n = narrate(ev.name, ev.input);
        if (onLine && n && Date.now() - p.lastSpokeAt > NARRATE_GAP_MS) {
          p.lastSpokeAt = Date.now();
          clearTimeout(p.filler);
          this.emit(p, { type: "narrate", project: id, turn, text: n });
        }
        break;
      }
      case "tool_result":
        rememberImages(p, String(ev.detail ?? ""));
        this.emit(p, { type: "tool_result", project: id, turn, id: ev.id, ok: ev.ok, summary: ev.summary, detail: ev.detail, images: ev.images });
        break;
      case "ask": {
        // paused on something risky: the head of the team asks the person, and the agent waits
        const { phrase, detail } = describeAction(ev.tool, ev.input);
        const risk = riskOf(ev.tool, ev.input) ?? undefined;
        const ask: Ask = { requestId: ev.requestId, tool: ev.tool, phrase, detail, reason: ev.reason, input: ev.input, suggestions: ev.suggestions, at: Date.now(), risk };
        p.asks.push(ask);
        p.state = "blocked";
        // the whole input goes to the page, which draws a plan to review or questions to pick from
        this.emit(p, { type: "permission", project: id, turn, tool: ev.tool, requestId: ev.requestId, phrase, detail, input: ev.input, text: ev.reason || `${p.config.name} wants to ${phrase}.` });
        this.queue({ ...notification("permission", p.config.name, id, { phrase, risk, message: [detail, ev.reason].filter(Boolean).join("\n") }), requestId: ev.requestId, onLine: onLine || undefined, risk } as any);
        this.publish();
        break;
      }
      case "permission": {
        // Refused outright by the safety check, with nobody asked. If it can be allowed exactly —
        // one command, one file — it goes to the lead like any other request; saying yes allows
        // that and has the agent try again. Otherwise it is just reported.
        const { phrase, detail } = describeAction(ev.tool, ev.input);
        const rule = ruleFor(ev.tool, ev.input);
        this.emit(p, { type: "permission", project: id, turn, tool: ev.tool, phrase, detail, text: ev.message, blocked: true });
        if (!rule) {
          this.queue(notification("blocked", p.config.name, id, { phrase, message: ev.message }));
          break;
        }
        const requestId = `denied-${ev.toolUseId || Date.now()}`;
        const risk = riskOf(ev.tool, ev.input) ?? undefined;
        p.asks.push({ requestId, tool: ev.tool, phrase, detail, reason: "The safety check stopped it.", input: ev.input, suggestions: [], at: Date.now(), retry: rule, risk });
        this.queue({ ...notification("permission", p.config.name, id, { phrase, risk, message: [detail, "The safety check stopped it; allowing it lets this exact action through and has it tried again."].filter(Boolean).join("\n") }), requestId, onLine: onLine || undefined, risk } as any);
        this.publish();
        break;
      }
      case "error":
        this.emit(p, { type: "error", project: id, turn, text: `${p.config.name} hit a problem: ${ev.message}` });
        if (!onLine) this.queue(notification("failed", p.config.name, id, { message: ev.message, said: p.said }));
        break;
      case "model":
        p.running = ev.model;
        this.publish();
        break;
      case "compacted":
        // its conversation was summarised: tell it where things stand again, in full, next time
        p.told = null;
        break;
      case "dropped":
        // a queued message let go before it ran: its card on the page is closed, nothing more
        this.emit(p, { type: "done", project: id, turn, interrupted: true });
        break;
      case "done": {
        p.costUsd += ev.costUsd ?? 0;
        p.busyMs += ev.ms ?? 0;
        clearTimeout(p.filler);
        p.transcript?.session(ev.sessionId);
        if (ev.sessionId && ev.sessionId !== p.sessionId) {
          p.sessionId = ev.sessionId;
          if (!p.central) this.remember();
        }
        if (!ev.interrupted) await this.parsed(p, turn, p.parserFor(turn).end());
        p.parsers.delete(turn);
        if (p.handoff) {
          const h = p.handoff;
          p.handoff = null;
          if (!ev.interrupted) {
            const problem = this.handoff(id, h.to, h.note);
            if (problem) this.ask(id, `[your handoff did not go through: ${problem}]`, null, { keepFocus: true, queue: true });
          }
        }
        p.turnsDone++;
        // the one-line report is the opening of its final answer — the verdict — not its last line
        if (!ev.interrupted) p.report = (p.answer.length ? summarise([p.answer[0]]) : summarise(p.said)) || p.report;
        if (!p.central && !ev.interrupted) this.notebook.status(p.config.name, p.report);
        // a background turn that ends on a question is a question, tagged or not
        if (!onLine && !ev.interrupted && !p.pendingQuestion && !p.central && /\?$/.test(p.report) && p.said.length) p.pendingQuestion = p.report;
        if (onLine) p.pendingQuestion = null; // asked out loud, to someone listening
        // a turn that ended took its paused requests with it; refusals wait for the lead's answer
        p.asks = p.asks.filter((a) => a.retry);
        if (p.pendingQuestion && !p.questionId) { p.questionId = `q-${id}-${turn}`; p.questionAt = Date.now(); }
        if (!p.pendingQuestion) p.questionId = "";
        p.state = p.pendingQuestion ? "blocked" : p.session?.isBusy() ? "working" : "warm";
        this.emit(p, { type: "done", project: id, turn, interrupted: ev.interrupted || undefined });
        // the point of working in parallel: when a project you are not listening to finishes,
        // the central voice tells you, with that project's own closing line as the report
        if (!onLine && !ev.interrupted) {
          if (p.pendingQuestion) this.queue({ ...notification("question", p.config.name, id, { question: p.pendingQuestion }), questionId: p.questionId } as any);
          // more work already queued behind this turn (a retry, a follow-up): not finished yet
          else if (!p.session?.isBusy()) this.queue(notification("finished", p.config.name, id, { said: [p.report], full: p.said.join(" ") }));
        }
        this.publish();
        const actions = p.actions;
        p.actions = [];
        p.said = []; // the next turn, queued or not, starts its own report
        p.answer = [];
        if (p.central && !ev.interrupted && actions.length) await this.act(actions);
        break;
      }
    }
  }
}

/** Picture paths named in a tool's input or output, kept newest first: a few, not a history. */
function rememberImages(p: Project, text: string): void {
  const found = text.match(/(?:~|\.{0,2}\/)?[\w.\-\/~]*[\w-]\.(?:png|jpe?g|gif|webp|svg|bmp)\b/gi) ?? [];
  for (const f of found.reverse()) {
    if (f.startsWith("/tmp/") && /b64|base64/i.test(f)) continue;
    p.images = [f, ...p.images.filter((x) => x !== f)].slice(0, 12);
  }
}

/** Words worth knowing from a tool call: file names and the words of a command, newest first. */
function rememberTerms(p: Project, input: unknown): void {
  const i = (input ?? {}) as Record<string, unknown>;
  const found: string[] = [];
  for (const k of ["file_path", "notebook_path", "path"]) if (typeof i[k] === "string") found.push(String(i[k]).split("/").pop() ?? "");
  if (typeof i.command === "string") found.push(...String(i.command).split(/[\s|&;()'"=]+/).filter((w) => /^[\w./@-]{3,40}$/.test(w) && !/^-/.test(w)).map((w) => w.split("/").pop() ?? w));
  if (typeof i.pattern === "string") found.push(String(i.pattern));
  for (const w of found.reverse()) {
    if (!w || w.length < 3) continue;
    p.terms = [w, ...p.terms.filter((x) => x !== w)].slice(0, 40);
  }
}

/**
 * A <voice> tag's attributes as a sound setting. Accepts what is natural to say: a voice name,
 * speed as a number (1 is normal) or "faster"/"slower", volume as 0–1, a percentage, or
 * "louder"/"quieter", and a side as left, right or centre.
 */
export function voicePatch(a: Record<string, string>, now: { rate: number; volume?: number; pitch: number }): Sound {
  const num = (v?: string) => (v && /^-?\d*\.?\d+%?$/.test(v.trim()) ? (v.trim().endsWith("%") ? parseFloat(v) / 100 : parseFloat(v)) : undefined);
  const speed = a.speed ?? a.rate;
  const vol = a.volume;
  const side = (a.side ?? a.pan ?? "").toLowerCase();
  return {
    voice: a.name ?? a.voice,
    rate: speed === "faster" ? now.rate + 0.12 : speed === "slower" ? now.rate - 0.12 : num(speed),
    volume: vol === "louder" ? Math.min(1, (now.volume ?? 1) + 0.2) : vol === "quieter" || vol === "softer" ? Math.max(0.1, (now.volume ?? 1) - 0.2) : num(vol),
    pitch: a.pitch === "higher" ? now.pitch + 0.1 : a.pitch === "lower" ? now.pitch - 0.1 : num(a.pitch),
    pan: side === "left" ? -0.7 : side === "right" ? 0.7 : /^(centre|center|middle)$/.test(side) ? 0 : num(a.pan),
  };
}

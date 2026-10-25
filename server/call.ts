import { ClaudeSession } from "./agent.ts";
import { CENTRAL, CENTRAL_ID, CENTRAL_NAME } from "./identity.ts";
import { clean } from "./cleaner.ts";
import { formatContext, type CallContext } from "./context.ts";
import { narrate, toolDetail, toolLabel } from "./narration.ts";
import { describeAction, notification, ruleFor, sayable, summarise, type Notification } from "./notify.ts";
import { ReplyParser, type ParsedEvent } from "./parser.ts";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { homedir } from "node:os";
import { resolveDir } from "./paths.ts";
import { ago, findSessions } from "./sessions.ts";
import { branchOf, projectFor, saveRoster, type ProjectConfig } from "./projects.ts";
import { Transcript } from "./transcript.ts";
import type { Mode, Rewriter } from "./types.ts";

const FILLER_MS = 3500;
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
  /** The closing line of its last finished turn: what it would say if you asked how it is doing. */
  report = "";
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
  /** Side questions asked mid-task and their answers, so each one has the ones before it. */
  btwHistory: { question: string; response: string }[] = [];
  /** Control tags the central agent wrote this turn, carried out once the turn ends. */
  actions: Action[] = [];
  branch = "";
  turnsDone = 0;
  sessionId = "";

  constructor(config: ProjectConfig, central = false) {
    this.config = config;
    this.central = central;
    this.sessionId = config.resume ?? "";
  }

  parserFor(turn: number): ReplyParser {
    return this.parsers.get(turn) ?? this.parsers.set(turn, new ReplyParser()).get(turn)!;
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

  constructor(opts: CallOptions) {
    this.opts = opts;
    this.central = new Project({
      id: CENTRAL_ID,
      name: CENTRAL_NAME,
      dir: opts.home,
      identity: CENTRAL,
      // she only acts on things you ask for, while you are listening, and only inside her home
      permissionMode: "auto",
      backgroundPermissionMode: "auto",
      engagement: "pair",
    }, true);
    this.projects.set(CENTRAL_ID, this.central);
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
      p.actions = [];
      p.lastSpokeAt = 0;
    }
    p.pendingQuestion = null;
    p.questionId = "";
    const lead = [formatContext(this.mode, ctx, onLine), from, p.central ? this.situation() : ""].filter(Boolean).join(" ");
    const turn = p.session!.send(`${lead} ${text}`, { interrupt: !queued, replaceQueued: queued && !!ctx?.replace });
    p.turn = turn;
    p.state = "working";
    p.lastActivity = Date.now();
    clearTimeout(p.filler);
    // the "one sec" filler is only for the agent you are actually listening to, and only when it
    // is starting fresh: one that is mid-task has already said what it is doing
    if (onLine && !queued) {
      p.filler = setTimeout(() => {
        if (!p.lastSpokeAt && this.focused === id) {
          p.lastSpokeAt = Date.now();
          this.opts.send({ type: "narrate", project: id, turn, text: "One sec." });
        }
      }, FILLER_MS);
    }
    this.opts.send({ type: "turn", project: id, turn, text, background: !onLine || undefined, queued: queued || undefined, assigned: assigned || undefined });
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
    if (!p.session?.isBusy()) return this.ask(id, text);
    const turn = p.turn;
    this.emit(p, { type: "btw", project: id, turn, phase: "asked", text });
    const question = [
      `[A side question from the lead, said out loud while you keep working. Do not stop your work.]`,
      text,
      ``,
      `Reply in one to three short spoken sentences: plain words, no markdown, no code, no file paths.`,
      `If answering properly needs you to do or change something — run a command, edit a file, start new work — reply with exactly "QUEUE:" followed by a few words saying you will do it as soon as your current task is done.`,
    ].join("\n");
    let answer = "";
    try {
      answer = await p.session.sideQuestion(question, p.btwHistory);
    } catch (e: any) {
      answer = "QUEUE: I'll get to that as soon as I've finished this.";
      console.warn(`side question to ${p.config.name} failed: ${e.message}`);
    }
    // agents are used to wrapping speech in <say>: keep what is inside, drop any <screen> part
    const said = [...answer.matchAll(/<say>([\s\S]*?)(?:<\/say>|$)/g)].map((m) => m[1].trim()).join(" ");
    answer = (said || answer).replace(/<screen>[\s\S]*?(<\/screen>|$)/g, " ").replace(/<\/?[a-z]+>/g, " ").replace(/\s+/g, " ").trim();
    p.btwHistory = [...p.btwHistory, { question: text, response: answer }].slice(-6);
    const queued = /^\s*QUEUE:?\s*([\s\S]*)$/i.exec(answer);
    if (queued) {
      // new work: it waits behind the current task, nothing is interrupted
      this.ask(id, text, { kind: "followup", working: true, queued: true }, { keepFocus: true, queue: true });
    }
    const spoken = sayable(clean(queued ? queued[1].trim() || "I'll do that as soon as I've finished this." : answer, this.mode), 400);
    if (spoken) this.emit(p, { type: "btw", project: id, turn, phase: "answer", text: spoken, queued: !!queued || undefined, spoken: this.focused === id });
  }

  /** Something the person said for a project that is not on the line, passed on without moving it. */
  tell(id: string, text: string): boolean {
    const p = this.projects.get(id);
    if (!p || p.central) return false;
    if (p.state === "parked") p.state = "cold";
    this.ask(id, text, null, { keepFocus: true, queue: true, from: `[the person says this to you through ${CENTRAL_NAME}; reply in one short sentence]` });
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
  grant(id: string, scope: "once" | "always" = "once", requestId?: string): boolean {
    return this.settle(id, true, scope === "always", requestId);
  }

  /** Say no. The agent is told, and carries on without it or stops and says what is left. */
  deny(id: string, requestId?: string): boolean {
    return this.settle(id, false, false, requestId);
  }

  private settle(id: string, allow: boolean, always: boolean, requestId?: string): boolean {
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
    } else ok = p.session.answer(ask.requestId, allow, { always, suggestions: ask.suggestions, input: ask.input });
    if (p.state === "blocked" && !p.asks.length) p.state = "working";
    this.emit(p, { type: "answered", project: id, requestId: ask.requestId, allow, always: always || undefined, phrase: ask.phrase });
    this.publish();
    return ok;
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
    if (this.focused === id) this.focused = CENTRAL_ID;
    this.publish();
  }

  /** Take a project off the roster altogether. Its folder and its conversation stay on disk. */
  remove(id: string): void {
    const p = this.projects.get(id);
    if (!p || p.central) return;
    this.park(id);
    this.projects.delete(id);
    this.order = this.order.filter((x) => x !== id);
    this.publish();
    this.remember();
  }

  async close(): Promise<void> {
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
    if (problems.length) this.ask(CENTRAL_ID, `[result of your actions] ${problems.join(" ")}`, null, { keepFocus: true });
  }

  private async perform(a: Action): Promise<string | null> {
    const { attrs, body } = a;
    switch (a.name) {
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
        return this.adopt(dir, { name: attrs.name, resume: false, brief: body, focus: attrs.focus, prompt: attrs.prompt });
      }
      case "open": {
        const found = await resolveDir(attrs.path ?? "", this.opts.home);
        if (found.kind === "empty") return "The open tag had no path.";
        if (found.kind === "ambiguous") return `"${attrs.path}" matches several folders: ${found.options!.map(tilde).join(", ")}. Ask the person which one, then open it by its full path.`;
        if (found.kind === "missing") return `No folder matching "${attrs.path}" was found${found.dir ? ` (${tilde(found.dir)} does not exist)` : ""}. Ask the person where it is, or offer to make a new project.`;
        const resume = attrs.resume === "new" ? false : attrs.resume === "last" ? true : attrs.resume || undefined;
        return this.adopt(found.dir!, { name: attrs.name, resume, brief: body, focus: attrs.focus, prompt: attrs.prompt });
      }
    }
    return null;
  }

  /**
   * Add a folder to the roster and give it an agent. With a brief, the agent starts on it at
   * once, in the background unless asked otherwise; without one, it is put on the line.
   * `resume`: undefined to find out, false for a fresh session, true for the latest, or an id.
   */
  private async adopt(dir: string, o: { name?: string; resume?: string | boolean; brief?: string; focus?: string; prompt?: string }): Promise<string | null> {
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

    const config = projectFor(dir, this.order.length, this.order, { ...(o.name ? { name: o.name } : {}), ...(o.prompt ? { prompt: o.prompt } : {}) });
    config.resume = resume;
    const p = new Project(config);
    p.branch = await branchOf(dir);
    this.projects.set(config.id, p);
    this.order.push(config.id);
    this.opts.send({ type: "opened", project: config.id, name: config.name, dir, resumed: resume ?? null, identity: config.identity });
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
      from: `[a task from ${CENTRAL_NAME}, on the person's behalf]`,
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
    const entry = `## ${new Date().toISOString().slice(0, 10)} — from ${CENTRAL_NAME}\n\n${brief.trim()}\n`;
    await writeFile(file, had ? `${had.trimEnd()}\n\n${entry}` : `# ${name}\n\nWhat this project is for, as handed out by ${CENTRAL_NAME}. Newest last.\n\n${entry}`);
  }

  /**
   * Make or open a project straight from the page, without a model in the loop: the form on the
   * screen is exact, so there is nothing for the central agent to interpret. Returns a problem
   * to show, or null.
   */
  async create(o: { name?: string; folder?: string; path?: string; brief?: string; focus?: boolean; prompt?: string }): Promise<string | null> {
    const attrs: Record<string, string> = {};
    if (o.name) attrs.name = o.name;
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

  /** What the central agent is told at the top of every turn: who is on the call and how they are. */
  private situation(): string {
    const lines = this.order.map((id) => {
      const p = this.projects.get(id)!;
      const where = this.focused === id ? "on the line" : p.state === "working" ? "working in the background" : p.state === "parked" ? "parked" : p.state === "cold" ? "not started" : "idle";
      const bits = [`${p.config.name} (id ${id}) in ${tilde(p.config.dir)}: ${where}`];
      if (p.asks.length) bits.push(`paused, waiting for the person to allow: ${p.asks.map((a) => a.phrase).join("; ")}`);
      if (p.pendingQuestion) bits.push(`asked: "${oneLine(p.pendingQuestion)}"`);
      if (p.report) bits.push(`last said: "${oneLine(p.report)}"`);
      return bits.join(", ");
    });
    const waiting = this.order.map((id) => this.projects.get(id)!).filter((p) => p.asks.length || p.pendingQuestion).map((p) => p.config.name);
    return `[projects: ${lines.length ? lines.join("; ") : "none yet"}] [waiting on the lead: ${waiting.length ? waiting.join(", ") : "nobody"}; the page tracks these and reads them out when the lead asks]`;
  }

  // ---------- internals ----------

  private view(id: string) {
    const p = this.projects.get(id)!;
    return {
      id,
      name: p.config.name,
      dir: p.config.dir,
      central: p.central || undefined,
      branch: p.branch,
      state: p.state,
      focused: this.focused === id,
      engagement: p.config.engagement,
      permissionMode: p.session ? p.session.mode : p.config.permissionMode,
      waiting: p.asks[0]?.phrase ?? null,
      asks: p.asks.map((a) => ({ requestId: a.requestId, tool: a.tool, phrase: a.phrase, detail: a.detail, reason: a.reason, at: a.at })),
      sessionId: p.sessionId || null,
      resumed: !!p.config.resume,
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
      return { name: p.config.name, dir: p.config.dir, sessionId: p.sessionId || undefined, prompt: p.config.prompt };
    });
    saveRoster(this.opts.rosterFile, list).catch((e) => console.error("Could not save the roster:", e.message));
  }

  /** The per-project half of the voice prompt: who it is, and that it is not alone. */
  private preamble(p: Project): string {
    if (p.central) return this.opts.centralPrompt;
    const others = this.order.filter((id) => id !== p.config.id).map((id) => this.projects.get(id)!.config.name);
    const lines = [
      `# Who you are on this call`,
      ``,
      `You are **${p.config.name}**, a member of the lead's team. Your project is the folder \`${p.config.dir}\`, and you are its own agent, with your own conversation.`,
      ``,
      `This is a live team meeting. The person on the call is **the lead**: they run the team, and they talk to one of you at a time. ${CENTRAL_NAME} is the lead's assistant: she sets projects up, hands out work on the lead's behalf, switches the lead between you, and keeps track of who needs the lead's input. She does not manage you and does not read your work.`,
      others.length
        ? `Your teammates are ${others.join(", ")}. Speak only for your own project; if the lead asks about another one, say it is not yours and that ${CENTRAL_NAME} can put them through.`
        : `You are the only project on the team so far.`,
      ``,
      `## When you have the floor`,
      `Each message says whether you are on the line. On the line, the lead is talking with you right now and everything in \`<say>\` is spoken aloud in your own voice. Talk like a teammate in a meeting: lead with the point, keep it short, and end with a clear ask or hand-back. ${p.config.engagement === "delegate" ? "You are in delegate mode: one line when you start and one when you finish, no running commentary." : "Give brief updates while you work, as the voice guide describes."}`,
      ``,
      `## When you are in the background`,
      `The lead is talking with someone else. Nothing you say is spoken. Work quietly. When you finish, make your final \`<say>\` one sentence that stands alone as your report: ${CENTRAL_NAME} will offer it to the lead when they are free.`,
      `Only if you truly cannot go on without a decision from the lead, put one short, self-contained question in \`<question>…</question>\` and stop. It waits in the lead's queue; you get the answer as your next message. Do not ask about things you can reasonably decide yourself.`,
      ``,
      `## Work and permission`,
      `A message starting \`[a task from ${CENTRAL_NAME}, on the person's behalf]\` is work from the lead, passed on by ${CENTRAL_NAME}. Do it as if the lead had asked you directly.`,
      `Ordinary work goes ahead on its own. Anything the safety check judges risky pauses you until the lead answers; ${CENTRAL_NAME} brings it to them. Just wait, and carry on when it goes through. If the answer is no, carry on without it, or stop and say what is left undone. Never try to work around a refusal.`,
      `If your folder has a \`BRIEF.md\`, it is your mission: read it when you start, and keep to it.`,
      ...(p.config.prompt ? [``, `## The lead's instructions for you`, p.config.prompt] : []),
    ];
    return lines.join("\n");
  }

  private ensure(id: string): Project {
    const p = this.projects.get(id)!;
    if (p.session) return p;
    p.transcript ??= new Transcript(this.opts.callsDir, p.config.name);
    p.transcript.open({ project: p.config.name, cwd: p.config.dir, branch: p.branch, permissionMode: p.config.permissionMode });
    const session = new ClaudeSession({
      cwd: p.config.dir,
      systemPrompt: `${this.preamble(p)}\n\n${this.opts.systemPrompt}`,
      permissionMode: this.focused === id ? p.config.permissionMode : p.config.backgroundPermissionMode,
      resume: p.sessionId || undefined,
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
        else this.emit(p, { type: "aside", project: id, turn, text: e.text });
      } else {
        // no <say> at all: speak the opening of the reply and put the whole thing on screen
        const parts = clean(e.text, this.mode).match(/[^.!?]+[.!?]*/g) ?? [];
        for (const s of parts.slice(0, 2)) await this.say(p, turn, s.trim());
        if (parts.length > 2) this.emit(p, { type: "screen", project: id, turn, text: e.text });
      }
    }
  }

  private queue(n: Notification): void {
    this.opts.send({ type: "notify", ...n });
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
        this.emit(p, { type: "tool_result", project: id, turn, id: ev.id, ok: ev.ok, summary: ev.summary, detail: ev.detail });
        break;
      case "ask": {
        // paused on something risky: the head of the team asks the person, and the agent waits
        const { phrase, detail } = describeAction(ev.tool, ev.input);
        const ask: Ask = { requestId: ev.requestId, tool: ev.tool, phrase, detail, reason: ev.reason, input: ev.input, suggestions: ev.suggestions, at: Date.now() };
        p.asks.push(ask);
        p.state = "blocked";
        this.emit(p, { type: "permission", project: id, turn, tool: ev.tool, requestId: ev.requestId, phrase, detail, text: ev.reason || `${p.config.name} wants to ${phrase}.` });
        this.queue({ ...notification("permission", p.config.name, id, { phrase, message: [detail, ev.reason].filter(Boolean).join("\n") }), requestId: ev.requestId, onLine: onLine || undefined } as any);
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
        p.asks.push({ requestId, tool: ev.tool, phrase, detail, reason: "The safety check stopped it.", input: ev.input, suggestions: [], at: Date.now(), retry: rule });
        this.queue({ ...notification("permission", p.config.name, id, { phrase, message: [detail, "The safety check stopped it; allowing it lets this exact action through and has it tried again."].filter(Boolean).join("\n") }), requestId, onLine: onLine || undefined } as any);
        this.publish();
        break;
      }
      case "error":
        this.emit(p, { type: "error", project: id, turn, text: `${p.config.name} hit a problem: ${ev.message}` });
        if (!onLine) this.queue(notification("failed", p.config.name, id, { message: ev.message, said: p.said }));
        break;
      case "done": {
        clearTimeout(p.filler);
        p.transcript?.session(ev.sessionId);
        if (ev.sessionId && ev.sessionId !== p.sessionId) {
          p.sessionId = ev.sessionId;
          if (!p.central) this.remember();
        }
        if (!ev.interrupted) await this.parsed(p, turn, p.parserFor(turn).end());
        p.parsers.delete(turn);
        p.turnsDone++;
        if (!ev.interrupted) p.report = summarise(p.said) || p.report;
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
          else if (!p.session?.isBusy()) this.queue(notification("finished", p.config.name, id, { said: p.said }));
        }
        this.publish();
        const actions = p.actions;
        p.actions = [];
        p.said = []; // the next turn, queued or not, starts its own report
        if (p.central && !ev.interrupted && actions.length) await this.act(actions);
        break;
      }
    }
  }
}

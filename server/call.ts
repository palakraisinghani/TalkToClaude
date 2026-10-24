import { ClaudeSession } from "./agent.ts";
import { CENTRAL_NAME } from "./identity.ts";
import { clean } from "./cleaner.ts";
import { formatContext, type CallContext } from "./context.ts";
import { narrate, toolDetail, toolLabel } from "./narration.ts";
import { batch, notification, type Notification } from "./notify.ts";
import { ReplyParser, type ParsedEvent } from "./parser.ts";
import { mkdir } from "node:fs/promises";
import { resolveDir } from "./paths.ts";
import { ago, findSessions, type PastSession } from "./sessions.ts";
import { branchOf, projectFor, type ProjectConfig } from "./projects.ts";
import { Transcript } from "./transcript.ts";
import type { Mode, Rewriter } from "./types.ts";

const FILLER_MS = 3500;
const NARRATE_GAP_MS = 6000;

export type ProjectState = "cold" | "warm" | "working" | "parked" | "blocked";

/** Everything the server keeps for one project for the length of one call. */
class Project {
  readonly config: ProjectConfig;
  session: ClaudeSession | null = null;
  transcript: Transcript | null = null;
  parsers = new Map<number, ReplyParser>();
  state: ProjectState = "cold";
  /** Sentences this project has produced in the running turn, for its own one-line report. */
  said: string[] = [];
  turn = 0;
  lastSpokeAt = 0;
  lastActivity = 0;
  filler: ReturnType<typeof setTimeout> | undefined;
  chain: Promise<unknown> = Promise.resolve();
  pendingPermission: { tool: string; message: string } | null = null;
  /** Set when permission was granted for one turn only; the mode goes back when it ends. */
  revertAfterTurn: string | null = null;
  branch = "";
  turnsDone = 0;
  /** A past session id to pick up, used once when the process is first spawned. */
  resume?: string;

  constructor(config: ProjectConfig) {
    this.config = config;
  }

  parserFor(turn: number): ReplyParser {
    return this.parsers.get(turn) ?? this.parsers.set(turn, new ReplyParser()).get(turn)!;
  }
}

export interface CallOptions {
  projects: ProjectConfig[];
  /** Where relative paths and folder searches start from. */
  appRoot: string;
  /** The shared voice prompt; each project gets it with its own identity prepended. */
  systemPrompt: string;
  callsDir: string;
  rewriter: Rewriter;
  send: (m: Record<string, any>) => void;
}

/**
 * One call: the whole roster, with at most one project on the line. Anything the other projects
 * need to say becomes a notification for the central voice, so two project voices can never talk
 * over each other — there is only ever the central voice, or the central voice and one project.
 */
export class Call {
  private projects = new Map<string, Project>();
  private order: string[] = [];
  private focused: string | null = null;
  private mode: Mode = "visual";
  private opts: CallOptions;
  private pending: Notification[] = [];
  private started = 0;
  /** A folder found to have past sessions, waiting on resume-or-new. */
  private asking: { dir: string; sessions: PastSession[] } | null = null;

  constructor(opts: CallOptions) {
    this.opts = opts;
    for (const c of opts.projects) {
      this.projects.set(c.id, new Project(c));
      this.order.push(c.id);
    }
  }

  get roster() {
    return this.order.map((id) => this.view(id));
  }

  setMode(mode: Mode): void {
    this.mode = mode;
  }

  /** Begin the call. With an empty roster there is nothing to warm: Ada waits to be asked. */
  async start(): Promise<void> {
    this.started = Date.now();
    await Promise.all(this.order.map(async (id) => {
      const p = this.projects.get(id)!;
      p.branch = await branchOf(p.config.dir);
    }));
    this.publish();
    if (this.order.length) this.focus(this.order[0]);
  }

  /**
   * Open a folder as a new project.
   *
   * The folder is worked out from what was said, then checked for past Claude sessions in that
   * directory — including ones from the terminal, since they are read from the CLI's own store.
   * None, and a fresh session starts. Some, and nothing happens yet: the choice is put to the
   * person, because silently reviving an old conversation and silently discarding one are both
   * surprising.
   */
  async open(spoken: string, opts: { resume?: string | boolean; create?: boolean; name?: string } = {}): Promise<void> {
    // undefined means "find out"; false means "start fresh"; a string resumes that session
    const found = await resolveDir(spoken, this.opts.appRoot);
    if (found.kind === "empty") return this.opts.send({ type: "open-failed", reason: "empty" });
    if (found.kind === "ambiguous") {
      return this.opts.send({ type: "open-failed", reason: "ambiguous", heard: found.heard, options: found.options });
    }
    if (found.kind === "missing") {
      if (!(opts.create && found.dir)) {
        return this.opts.send({ type: "open-failed", reason: "missing", heard: found.heard, dir: found.dir });
      }
      await mkdir(found.dir, { recursive: true });
    }
    const dir = found.dir!;

    const already = this.order.map((id) => this.projects.get(id)!).find((p) => p.config.dir === dir);
    if (already) {
      // already open: just put it back on the line rather than making a second agent for it
      this.opts.send({ type: "open-failed", reason: "already", project: already.config.id, name: already.config.name });
      this.focus(already.config.id);
      return;
    }

    let resume: string | undefined;
    if (opts.resume === undefined) {
      const sessions = await findSessions(dir);
      if (sessions.length) {
        this.asking = { dir, sessions };
        return this.opts.send({
          type: "open-choice",
          dir,
          name: projectFor(dir, this.order.length, this.names()).name,
          sessions: sessions.slice(0, 3).map((x) => ({ id: x.id, ago: ago(x.at), label: x.label })),
          count: sessions.length,
        });
      }
    } else if (typeof opts.resume === "string") resume = opts.resume || undefined;
    else if (opts.resume === true) resume = (await findSessions(dir))[0]?.id;

    this.asking = null;
    const config = projectFor(dir, this.order.length, this.names(), opts.name ? { name: opts.name } : {});
    const p = new Project(config);
    p.branch = await branchOf(dir);
    p.resume = resume;
    this.projects.set(config.id, p);
    this.order.push(config.id);
    this.opts.send({ type: "opened", project: config.id, name: config.name, dir, resumed: resume ?? null, identity: config.identity });
    this.focus(config.id);
    this.ensure(config.id); // warm it now, so the first question does not wait on a cold start
  }

  /** Answer the resume-or-new question that open() put to the person. */
  async answer(choice: "resume" | "new", sessionId?: string): Promise<void> {
    const q = this.asking;
    if (!q) return;
    this.asking = null;
    await this.open(q.dir, { resume: choice === "resume" ? sessionId ?? q.sessions[0].id : false });
  }

  get awaitingChoice(): boolean {
    return !!this.asking;
  }

  private names(): string[] {
    return this.order.map((id) => this.projects.get(id)!.config.id);
  }

  /** Put a project on the line. The one leaving keeps working, quietly and more cautiously. */
  focus(id: string | null): void {
    if (id !== null && !this.projects.has(id)) return;
    if (this.focused === id) return;
    const leaving = this.focused ? this.projects.get(this.focused) : null;
    if (leaving) {
      // nobody is listening to approve things now, so drop it to its background mode
      leaving.session?.setPermissionMode(leaving.config.backgroundPermissionMode);
      clearTimeout(leaving.filler);
    }
    this.focused = id;
    if (id) {
      const p = this.ensure(id);
      p.session!.setPermissionMode(p.config.permissionMode);
      p.lastActivity = Date.now();
    }
    this.publish();
  }

  /** Send a question to a project, putting it on the line first. Unnamed goes to whoever is on it. */
  ask(to: string | null | undefined, text: string, ctx?: CallContext | null, { keepFocus = false } = {}): void {
    const id = to && this.projects.has(to) ? to : this.focused ?? this.order[0];
    if (!id) return;
    if (!keepFocus) this.focus(id);
    const p = this.ensure(id);
    const onLine = this.focused === id;
    p.said = [];
    const prompt = `${formatContext(this.mode, ctx, onLine)} ${text}`;
    const turn = p.session!.send(prompt);
    p.turn = turn;
    p.state = "working";
    p.pendingPermission = null;
    p.lastSpokeAt = 0;
    p.lastActivity = Date.now();
    clearTimeout(p.filler);
    // the "one sec" filler is only for the project you are actually listening to
    if (onLine) {
      p.filler = setTimeout(() => {
        if (!p.lastSpokeAt && this.focused === id) {
          p.lastSpokeAt = Date.now();
          this.opts.send({ type: "narrate", project: id, turn, text: "One sec." });
        }
      }, FILLER_MS);
    }
    this.opts.send({ type: "turn", project: id, turn, text });
    this.publish();
  }

  interrupt(id: string | null = this.focused): void {
    const p = id ? this.projects.get(id) : null;
    if (!p) return;
    clearTimeout(p.filler);
    p.session?.interrupt();
  }

  /**
   * Grant the permission a project is waiting on, out loud. The mode is raised in place, so the
   * session keeps its context, and the project is nudged to retry what it was blocked on.
   */
  grant(id: string, scope: "once" | "always" = "once"): boolean {
    const p = this.projects.get(id);
    if (!p?.session || !p.pendingPermission) return false;
    const want = p.config.permissionMode === "manual" ? "acceptEdits" : p.config.permissionMode;
    p.session.setPermissionMode(want);
    if (scope === "always") p.config.backgroundPermissionMode = want;
    // "once" means once: the raised mode is taken back as soon as this turn ends
    else p.revertAfterTurn = p.config.backgroundPermissionMode;
    const { tool } = p.pendingPermission;
    p.pendingPermission = null;
    p.state = "working";
    // granting must not move the line: you were talking to someone else, and you still are
    this.ask(id, `[permission granted out loud] You may now use ${tool}. Please retry what you were blocked on, then carry on.`, null, { keepFocus: true });
    return true;
  }

  /** Release a project's process, keeping its session id so it can be resumed where it left off. */
  park(id: string): void {
    const p = this.projects.get(id);
    if (!p) return;
    clearTimeout(p.filler);
    p.session?.close();
    p.session = null;
    p.parsers.clear();
    p.state = "parked";
    if (this.focused === id) this.focused = null;
    this.publish();
  }

  /** The notifications waiting to be read out, as one line, cleared as they are taken. */
  takePending(): { text: string; items: Notification[] } | null {
    if (!this.pending.length) return null;
    const items = this.pending;
    this.pending = [];
    return { text: batch(items), items };
  }

  async close(): Promise<void> {
    for (const p of this.projects.values()) {
      clearTimeout(p.filler);
      p.session?.close();
      p.session = null;
    }
    await Promise.all([...this.projects.values()].map((p) => p.transcript?.close()));
  }

  // ---------- internals ----------

  private view(id: string) {
    const p = this.projects.get(id)!;
    return {
      id,
      name: p.config.name,
      dir: p.config.dir,
      branch: p.branch,
      state: p.state,
      focused: this.focused === id,
      engagement: p.config.engagement,
      permissionMode: p.session ? p.session.mode : p.config.permissionMode,
      waiting: p.pendingPermission ? p.pendingPermission.tool : null,
      turns: p.turnsDone,
      identity: p.config.identity,
    };
  }

  private publish(): void {
    this.opts.send({ type: "roster", projects: this.roster, focused: this.focused });
  }

  /** The per-project half of the voice prompt: who it is, and that it is not alone. */
  private preamble(p: Project): string {
    const others = this.order.filter((id) => id !== p.config.id).map((id) => this.projects.get(id)!.config.name);
    const lines = [
      `# Who you are on this call`,
      ``,
      `You are **${p.config.name}**, the voice of the project in \`${p.config.dir}\`.`,
      others.length
        ? `You are one of several projects on this call: ${others.join(", ")}. Only ever speak for your own project, and never answer for another one. If the person asks about another project, say it is not yours and that they should ask ${others[0]} directly.`
        : `You are the only project on this call.`,
      ``,
      `The person reaches you through ${CENTRAL_NAME}, who manages the projects on this call and does not read your work. Only one project is on the line at a time. When you are **on the line**, everything in \`<say>\` is spoken aloud in your own voice. When you are **in the background**, your words are not spoken: ${CENTRAL_NAME} reads out a one-line summary instead, so make your final \`<say>\` of a turn a sentence that stands on its own as a report.`,
      ``,
      p.config.engagement === "delegate"
        ? `You are in delegate mode: work independently and speak rarely. One line when you start, one when you finish. No running commentary.`
        : `You are in pair mode: talk while you work, as the voice guide describes.`,
      ``,
      `If something you try is refused for want of permission, say so in one short sentence and stop. ${CENTRAL_NAME} will ask the person out loud, and you will be told when you may continue. Never try to work around a refusal.`,
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
      resume: p.resume,
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
    // the page decides whether this is spoken: only the project on the line has a voice
    this.emit(p, { type: "say", project: p.config.id, turn, text: s, spoken: this.focused === p.config.id });
  }

  private async parsed(p: Project, turn: number, events: ParsedEvent[]): Promise<void> {
    const id = p.config.id;
    for (const e of events) {
      if (e.kind === "sentence") await this.say(p, turn, e.text);
      else if (e.kind === "screen") this.emit(p, { type: "screen", project: id, turn, text: e.text });
      else if (e.kind === "aside") this.emit(p, { type: "aside", project: id, turn, text: e.text });
      else {
        // no <say> at all: speak the opening of the reply and put the whole thing on screen
        const parts = clean(e.text, this.mode).match(/[^.!?]+[.!?]*/g) ?? [];
        for (const s of parts.slice(0, 2)) await this.say(p, turn, s.trim());
        if (parts.length > 2) this.emit(p, { type: "screen", project: id, turn, text: e.text });
      }
    }
  }

  private queue(n: Notification): void {
    this.pending.push(n);
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
      case "permission":
        p.pendingPermission = { tool: ev.tool, message: ev.message };
        p.state = "blocked";
        this.emit(p, { type: "permission", project: id, turn, tool: ev.tool, text: ev.message });
        this.queue(notification("permission", p.config.name, id, { tool: ev.tool, message: ev.message }));
        this.publish();
        break;
      case "error":
        this.emit(p, { type: "error", project: id, turn, text: `${p.config.name} hit a problem: ${ev.message}` });
        if (!onLine) this.queue(notification("failed", p.config.name, id, { message: ev.message, said: p.said }));
        break;
      case "done": {
        clearTimeout(p.filler);
        p.transcript?.session(ev.sessionId);
        if (p.revertAfterTurn && this.focused !== id) {
          p.session?.setPermissionMode(p.revertAfterTurn);
          p.revertAfterTurn = null;
        }
        if (!ev.interrupted) await this.parsed(p, turn, p.parserFor(turn).end());
        p.parsers.delete(turn);
        p.turnsDone++;
        if (p.state !== "blocked") p.state = "warm";
        this.emit(p, { type: "done", project: id, turn, interrupted: ev.interrupted || undefined });
        // the point of working in parallel: when a project you are not listening to finishes,
        // the central voice tells you, with that project's own closing line as the report
        if (!onLine && !ev.interrupted && p.state !== "blocked") {
          this.queue(notification("finished", p.config.name, id, { said: p.said }));
        }
        this.publish();
        break;
      }
    }
  }
}

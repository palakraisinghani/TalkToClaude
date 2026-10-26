import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Agent, AgentEvent } from "./types.ts";

type Listener = (turn: number, event: AgentEvent) => void;
/** Largest base64 image passed on to the page; anything bigger stays a text summary. */
const IMAGE_MAX = 8_000_000;

/**
 * One warm `claude -p` process per call, fed user messages as stream-json on stdin.
 * Turns run one at a time; sending while busy interrupts the running turn first.
 */
export class ClaudeSession implements Agent {
  private child: ChildProcess | null = null;
  private listeners: Listener[] = [];
  private queue: { turn: number; text: string }[] = [];
  private active = 0; // turn currently running in Claude, 0 when idle
  private interrupted = new Set<number>();
  private turns = 0;
  private controls = 0;
  private sessionId = "";
  private streamed = false;
  private cwd: string;
  private systemPrompt: string;
  private permissionMode: string;
  private model: string;
  /** What the mode and model were before a change the CLI has not yet confirmed, to roll back to. */
  private modeBefore: string | null = null;
  private modelBefore: string | null = null;
  /** Set while a --resume has not yet been shown to work, so a dead session can fall back to a new one. */
  private resuming = false;
  private heard = false;
  private sent: { turn: number; text: string } | null = null;
  /** Permission requests the CLI is waiting on us to answer. */
  private asks = new Set<string>();
  private toolInputs = new Map<string, unknown>();
  /** Rules the lead has allowed out loud, for this session only. */
  private allowed: string[] = [];
  /** Control requests we sent and are waiting on an answer for. */
  private waiting = new Map<string, { resolve: (v: any) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();

  /** Extra command-line flags, and environment, for a session that is not a full agent (the Refiner). */
  private extraArgs: string[];
  private env: Record<string, string>;
  /** The model Claude Code last said it is running. */
  private running = "";
  /** How hard it thinks (--effort); set when the process starts. */
  private effort: string;
  private replacePrompt: boolean;

  constructor(opts: { cwd: string; systemPrompt: string; permissionMode?: string; resume?: string; model?: string; effort?: string; extraArgs?: string[]; env?: Record<string, string>; replaceSystemPrompt?: boolean }) {
    this.effort = opts.effort ?? "";
    this.cwd = opts.cwd;
    this.extraArgs = opts.extraArgs ?? [];
    this.env = opts.env ?? {};
    this.replacePrompt = !!opts.replaceSystemPrompt;
    this.model = opts.model ?? "";
    this.systemPrompt = opts.systemPrompt;
    this.permissionMode = opts.permissionMode ?? "auto";
    // picking up an earlier conversation in this directory: start() passes it to --resume
    if (opts.resume) { this.sessionId = opts.resume; this.resuming = true; }
  }

  get mode(): string {
    return this.permissionMode;
  }

  on(listener: Listener): void {
    this.listeners.push(listener);
  }

  start(): void {
    if (this.child) return;
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json",
      "--verbose", "--include-partial-messages",
      "--permission-mode", this.permissionMode,
      // permission prompts come to us over this same channel, as the Agent SDK has them; without
      // it Claude Code turns some tools off entirely — ExitPlanMode, so plan mode could never
      // hand a plan over for approval
      "--permission-prompt-tool", "stdio",
      ...(this.model ? ["--model", this.model] : []),
      ...(this.effort ? ["--effort", this.effort] : []),
      this.replacePrompt ? "--system-prompt" : "--append-system-prompt", this.systemPrompt,
      ...this.extraArgs,
      ...(this.sessionId ? ["--resume", this.sessionId] : []),
    ];
    const child = spawn("claude", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, ...this.env } });
    this.child = child;
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.stdin!.on("error", () => {});
    // spawn failures (no claude on PATH, no permission) arrive here, not on "close". Unhandled,
    // they would take the whole server down with them.
    child.on("error", (err) => {
      if (this.child !== child) return;
      stderr = err.message.includes("ENOENT") && err.message.includes("spawn claude")
        ? "Cannot find the claude command. Install Claude Code and make sure `claude` is on your PATH."
        : err.message;
    });
    // once closed (or replaced), anything this process still writes is ignored: a parked agent
    // must not report a finished turn, and an ended call must not log past its end
    createInterface({ input: child.stdout! }).on("line", (line) => { if (this.child === child) this.onLine(line); });
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      // a side question can never be answered by a process that has gone
      this.rejectWaiting("the agent stopped");
      // the session to resume is gone (deleted, or from another machine): start a fresh one and
      // replay what was asked, rather than leaving the project dead on arrival
      if (this.resuming && !this.heard) {
        this.resuming = false;
        this.sessionId = "";
        if (this.active && this.sent?.turn === this.active) this.queue.unshift(this.sent);
        this.active = 0;
        this.start();
        this.pump();
        return;
      }
      const turn = this.active;
      this.active = 0;
      // turn 0 means it died while warming up, before any question: still say so on the page
      this.emit(turn, { kind: "error", message: stderr.trim().split("\n").pop() || `Claude exited (${code})` });
      if (turn) this.emit(turn, { kind: "done", sessionId: this.sessionId, interrupted: true });
      this.pump();
    });
  }

  /**
   * Queue a message. By default the newest message wins: anything still waiting is dropped and the
   * running turn is cut. With `interrupt: false` it waits its turn instead, so work in progress —
   * a build, a test run — is never killed just because the person said something.
   * `replaceQueued` drops whatever is still waiting, without touching the running turn.
   */
  send(text: string, { interrupt = true, replaceQueued = false } = {}): number {
    const turn = ++this.turns;
    if (!interrupt && replaceQueued) {
      // the rest of a sentence whose first half was queued: it replaces that half, still waiting
      this.drop();
    }
    if (interrupt) {
      this.drop();
      this.queue = [{ turn, text }];
      if (this.active) this.interrupt();
    } else this.queue.push({ turn, text });
    this.pump();
    return turn;
  }

  /**
   * Change what this session is allowed to do, in place. The CLI accepts this at any time and
   * keeps the conversation, so granting a permission out loud costs nothing and loses nothing.
   * Before the process exists the mode is remembered and applied on spawn.
   */
  setPermissionMode(mode: string): void {
    if (mode === this.permissionMode) return;
    this.modeBefore = this.permissionMode;
    this.permissionMode = mode;
    if (!this.child) return; // start() will spawn with the new mode
    this.write({ type: "control_request", request_id: `mode-${++this.controls}`, request: { subtype: "set_permission_mode", mode } });
  }

  /**
   * Run on a different model from the next turn on, keeping the conversation. Empty means Claude
   * Code's default. Like the permission mode, it is changed in place over the control channel.
   */
  setModel(model: string): void {
    if (model === this.model) return;
    this.modelBefore = this.model;
    this.model = model;
    if (!this.child) return; // start() will spawn with it
    this.write({ type: "control_request", request_id: `model-${++this.controls}`, request: { subtype: "set_model", ...(model ? { model } : {}) } });
  }

  /** Stop everything: the running turn and anything queued behind it. This is what "stop" means. */
  stop(): void {
    this.drop();
    this.interrupt();
  }

  /**
   * Let go of everything still queued. Each dropped turn is reported, so the page can close its
   * card instead of leaving it "queued" for ever; it never ran, so there is nothing else to tell.
   */
  private drop(): void {
    const gone = this.queue;
    this.queue = [];
    for (const q of gone) this.emit(q.turn, { kind: "dropped" });
  }

  private rejectWaiting(why: string): void {
    for (const w of this.waiting.values()) { clearTimeout(w.timer); w.reject(new Error(why)); }
    this.waiting.clear();
  }

  interrupt(): void {
    if (!this.active || !this.child) return;
    this.interrupted.add(this.active);
    this.write({ type: "control_request", request_id: `int-${this.active}`, request: { subtype: "interrupt" } });
  }

  /**
   * Answer a paused permission request. `always` also applies the CLI's own suggested rules for
   * this session, so the same kind of action is not asked about again.
   */
  answer(requestId: string, allow: boolean, { always = false, suggestions = [] as unknown[], input = {} as unknown, message = "" } = {}): boolean {
    if (!this.asks.delete(requestId)) return false;
    const response = allow
      ? { behavior: "allow", updatedInput: input, ...(always && suggestions.length ? { updatedPermissions: suggestions } : {}) }
      : { behavior: "deny", message: message || "The person said no. Do not try this another way; carry on without it, or stop and say what is left undone." };
    this.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
    return true;
  }

  /**
   * Allow something the safety check refused, for this session only, as an exact permission rule
   * ("Bash(git push --force origin main)"). The CLI takes runtime settings over the control
   * channel; the whole list is sent each time, so nothing allowed earlier is dropped.
   */
  allow(rule: string): void {
    if (!this.allowed.includes(rule)) this.allowed.push(rule);
    this.write({ type: "control_request", request_id: `allow-${++this.controls}`, request: { subtype: "apply_flag_settings", settings: { permissions: { allow: this.allowed } } } });
  }

  /**
   * A side question — Claude Code's /btw. Answered from the conversation so far, with no tools,
   * while the running turn carries on untouched. This is how the lead can ask an agent something
   * mid-task without waiting for the task to finish, or stopping it.
   */
  sideQuestion(question: string, history: { question: string; response: string }[] = [], timeoutMs = 45_000): Promise<string> {
    if (!this.child) return Promise.reject(new Error("the agent is not running"));
    const id = `btw-${++this.controls}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.waiting.delete(id); reject(new Error("no answer in time")); }, timeoutMs);
      this.waiting.set(id, { resolve: (r) => resolve(String(r?.response ?? "").trim()), reject, timer });
      this.write({ type: "control_request", request_id: id, request: { subtype: "side_question", question, history } });
    });
  }

  close(): void {
    this.rejectWaiting("the agent was closed");
    this.queue = [];
    const c = this.child;
    this.child = null;
    c?.stdin?.end();
    setTimeout(() => c?.kill(), 1000);
  }

  isBusy(): boolean {
    return this.active !== 0 || this.queue.length > 0;
  }

  private pump() {
    if (this.active || !this.queue.length) return;
    this.start();
    const next = this.queue.shift()!;
    this.active = next.turn;
    this.sent = next;
    this.streamed = false;
    this.write({ type: "user", message: { role: "user", content: next.text } });
  }

  private write(obj: object) {
    this.child?.stdin?.write(JSON.stringify(obj) + "\n");
  }

  private emit(turn: number, ev: AgentEvent) {
    for (const l of this.listeners) l(turn, ev);
  }

  private onLine(line: string) {
    let ev: any;
    try { ev = JSON.parse(line); } catch { return; }
    // Only real conversation counts as the session working. Hook notices ("SessionStart") arrive
    // even when the session to resume no longer exists, so they prove nothing.
    if ((ev.type === "system" && ev.subtype === "init") || ev.type === "stream_event" || ev.type === "assistant") this.heard = true;
    // the exact model, as Claude Code reports it: at the start, and with every reply after a change
    const running = (ev.type === "system" && ev.subtype === "init" ? ev.model : ev.type === "assistant" ? ev.message?.model : "") || "";
    if (running && running !== this.running && !running.startsWith("<")) { this.running = running; this.emit(this.active, { kind: "model", model: running }); }
    const failedResume = this.resuming && !this.heard;
    if (ev.session_id && !failedResume) this.sessionId = ev.session_id;
    // Claude Code summarised the conversation to make room: what it was told before may be gone
    if (ev.type === "system" && ev.subtype === "compact_boundary") this.emit(this.active, { kind: "compacted" });
    if (ev.type === "control_request") {
      const r = ev.request ?? {};
      if (r.subtype === "can_use_tool") {
        // The permission mode could not decide on its own — in auto mode, the classifier thought
        // this one risky — so the agent is paused here until a person answers through answer().
        this.asks.add(String(ev.request_id));
        this.emit(this.active, {
          kind: "ask",
          requestId: String(ev.request_id),
          tool: String(r.tool_name ?? "a tool"),
          input: r.input ?? {},
          reason: String(r.decision_reason ?? r.description ?? "").replace(/\x1b\[[0-9;]*m/g, ""),
          title: r.title ? String(r.title) : "",
          suggestions: Array.isArray(r.permission_suggestions) ? r.permission_suggestions : [],
        });
      } else {
        // anything else the CLI asks of its host is not something Buddy offers; say so, so it never waits
        this.write({ type: "control_response", response: { subtype: "error", request_id: ev.request_id, error: `Buddy does not handle ${r.subtype}` } });
      }
      return;
    }
    if (ev.type === "control_response") {
      const r = ev.response ?? {};
      const w = this.waiting.get(String(r.request_id ?? ""));
      if (w) {
        this.waiting.delete(String(r.request_id));
        clearTimeout(w.timer);
        if (r.subtype === "success") w.resolve(r.response ?? {});
        else w.reject(new Error(String(r.error ?? "the request failed")));
        return;
      }
      if (r.subtype === "error" && String(r.request_id ?? "").startsWith("allow-")) {
        this.emit(this.active, { kind: "error", message: `Could not allow that: ${r.error}` });
      }
      // a refused change is rolled back, so what this session says it is matches what it is
      if (r.subtype === "error" && String(r.request_id ?? "").startsWith("model-")) {
        if (this.modelBefore !== null) this.model = this.modelBefore;
        this.emit(this.active, { kind: "error", message: `Could not change the model: ${r.error}` });
      }
      if (r.subtype === "error" && String(r.request_id ?? "").startsWith("mode-")) {
        if (this.modeBefore !== null) this.permissionMode = this.modeBefore;
        this.emit(this.active, { kind: "error", message: `Could not change what this project may do: ${r.error}` });
      }
      return;
    }
    const turn = this.active;
    if (!turn) return;
    // after an interrupt, swallow the tail of that turn until its result arrives
    const live = !this.interrupted.has(turn);
    if (ev.type === "stream_event") {
      const e = ev.event;
      if (e?.type === "content_block_start" && e.content_block?.type === "text") { this.streamed = true; if (live) this.emit(turn, { kind: "text", text: "\n" }); }
      if (e?.type !== "content_block_delta" || !live) return;
      if (e.delta?.type === "text_delta") { this.streamed = true; this.emit(turn, { kind: "text", text: e.delta.text }); }
      else if (e.delta?.type === "thinking_delta") this.emit(turn, { kind: "thinking", text: e.delta.thinking });
    } else if (ev.type === "assistant" && live) {
      for (const b of ev.message?.content ?? []) {
        if (b.type === "tool_use") {
          // remembered briefly, so a refusal can say exactly what was refused
          this.toolInputs.set(b.id, b.input);
          if (this.toolInputs.size > 50) this.toolInputs.delete(this.toolInputs.keys().next().value);
          this.emit(turn, { kind: "tool", id: b.id, name: b.name, input: b.input });
        }
        else if (b.type === "text" && !this.streamed) this.emit(turn, { kind: "text", text: b.text });
      }
      this.streamed = false;
    } else if (ev.type === "user" && live) {
      for (const b of ev.message?.content ?? []) {
        if (b.type !== "tool_result") continue;
        const raw = typeof b.content === "string" ? b.content : (b.content ?? []).map((c: any) => c.text ?? "").join("\n");
        // summary is one line for the card; detail keeps the original newlines and indentation
        const detail = raw.replace(/\x1b\[[0-9;]*m/g, "").replace(/\r\n?/g, "\n");
        const summary = detail.split("\n").find((l) => l.trim())?.trim().slice(0, 160) ?? "";
        // a Read of a picture comes back as an image block: keep it, so the panel can show it
        const images = (Array.isArray(b.content) ? b.content : [])
          .filter((c: any) => c.type === "image" && c.source?.type === "base64" && c.source.data?.length < IMAGE_MAX)
          .map((c: any) => `data:${c.source.media_type};base64,${c.source.data}`);
        this.emit(turn, { kind: "tool_result", id: b.tool_use_id, ok: !b.is_error, summary, detail: detail.length > 6000 ? detail.slice(0, 6000) + "\n…" : detail, ...(images.length ? { images } : {}) });
      }
    } else if (ev.type === "system" && ev.subtype === "permission_denied" && live) {
      // `manual` mode denies anything that would prompt and reports it here. This is how a
      // background project asks for permission: there is no prompt to answer, only a refusal.
      const toolUseId = String(ev.tool_use_id ?? "");
      this.emit(turn, { kind: "permission", tool: String(ev.tool_name ?? "a tool"), toolUseId, input: this.toolInputs.get(toolUseId) ?? {}, message: String(ev.message ?? "") });
    } else if (ev.type === "result") {
      // the session it tried to resume is gone: the process is about to exit, and the close
      // handler starts a fresh one. Put the message back so it is sent there, not lost.
      if (failedResume) {
        if (this.sent?.turn === turn) this.queue.unshift(this.sent);
        this.active = 0;
        return;
      }
      this.asks.clear();
      const interrupted = this.interrupted.delete(turn) || ev.subtype === "error_during_execution";
      if (ev.is_error && !interrupted) this.emit(turn, { kind: "error", message: String(ev.result || ev.subtype || "Claude reported an error") });
      this.active = 0;
      // what the turn cost and how long it took, as the CLI reports them, for the meter on the page
      this.emit(turn, { kind: "done", sessionId: this.sessionId, interrupted, costUsd: Number(ev.total_cost_usd) || 0, ms: Number(ev.duration_ms) || 0 });
      this.pump();
    }
  }
}

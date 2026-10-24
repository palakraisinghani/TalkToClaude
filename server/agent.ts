import { spawn, type ChildProcess } from "node:child_process";
import { createInterface } from "node:readline";
import type { Agent, AgentEvent } from "./types.ts";

type Listener = (turn: number, event: AgentEvent) => void;

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
  private sessionId = "";
  private streamed = false;
  private cwd: string;
  private systemPrompt: string;
  private permissionMode: string;

  constructor(opts: { cwd: string; systemPrompt: string; permissionMode?: string }) {
    this.cwd = opts.cwd;
    this.systemPrompt = opts.systemPrompt;
    this.permissionMode = opts.permissionMode ?? "auto";
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
      "--append-system-prompt", this.systemPrompt,
      ...(this.sessionId ? ["--resume", this.sessionId] : []),
    ];
    const child = spawn("claude", args, { cwd: this.cwd, stdio: ["pipe", "pipe", "pipe"] });
    this.child = child;
    let stderr = "";
    child.stderr!.on("data", (d) => (stderr = (stderr + d).slice(-2000)));
    child.stdin!.on("error", () => {});
    createInterface({ input: child.stdout! }).on("line", (line) => this.onLine(line));
    child.on("close", (code) => {
      if (this.child !== child) return;
      this.child = null;
      const turn = this.active;
      this.active = 0;
      if (turn) this.emit(turn, { kind: "error", message: stderr.trim().split("\n").pop() || `Claude exited (${code})` });
      if (turn) this.emit(turn, { kind: "done", sessionId: this.sessionId, interrupted: true });
      this.pump();
    });
  }

  send(text: string): number {
    const turn = ++this.turns;
    // newest message wins: drop anything still waiting and cut the running turn
    for (const q of this.queue) this.interrupted.add(q.turn);
    this.queue = [{ turn, text }];
    if (this.active) this.interrupt();
    this.pump();
    return turn;
  }

  interrupt(): void {
    if (!this.active || !this.child) return;
    this.interrupted.add(this.active);
    this.write({ type: "control_request", request_id: `int-${this.active}`, request: { subtype: "interrupt" } });
  }

  close(): void {
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
    if (ev.session_id) this.sessionId = ev.session_id;
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
        if (b.type === "tool_use") this.emit(turn, { kind: "tool", id: b.id, name: b.name, input: b.input });
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
        this.emit(turn, { kind: "tool_result", id: b.tool_use_id, ok: !b.is_error, summary, detail: detail.length > 6000 ? detail.slice(0, 6000) + "\n…" : detail });
      }
    } else if (ev.type === "result") {
      const interrupted = this.interrupted.delete(turn) || ev.subtype === "error_during_execution";
      if (ev.is_error && !interrupted) this.emit(turn, { kind: "error", message: String(ev.result || ev.subtype || "Claude reported an error") });
      this.active = 0;
      this.emit(turn, { kind: "done", sessionId: this.sessionId, interrupted });
      this.pump();
    }
  }
}

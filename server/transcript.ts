import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Per-turn shape kept in memory only to write the readable transcript at the end. */
interface Turn {
  n: number;
  you: string;
  said: string[];
  tools: string[];
  screen: string;
  errors: string[];
}

const trim = (s: unknown, n: number) => {
  const t = typeof s === "string" ? s : "";
  return t.length > n ? t.slice(0, n) + "…" : t;
};

/**
 * One call on disk: a JSONL log written as the call runs, so a crash or a reload keeps it, plus
 * a readable transcript of what was actually said and shown once the call ends. Token-level
 * streams (thinking, working notes) are left out; everything a listener experienced is kept.
 */
export class Transcript {
  readonly id: string;
  readonly dir: string;
  private started = Date.now();
  private chain: Promise<unknown> = Promise.resolve(); // appends never interleave
  private turns: Turn[] = [];
  private sessionId = "";
  private meta: Record<string, unknown> = {};
  private closed = false;

  constructor(dir: string, label = "", now = new Date()) {
    this.dir = dir;
    const stamp = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
    this.id = label ? `${stamp}-${label.toLowerCase().replace(/[^a-z0-9]+/g, "-")}` : stamp;
  }

  get jsonlPath(): string { return join(this.dir, `${this.id}.jsonl`); }
  get mdPath(): string { return join(this.dir, `${this.id}.md`); }

  open(meta: Record<string, unknown>): void {
    this.meta = meta;
    this.started = Date.now();
    this.#append({ type: "call-start", at: new Date(this.started).toISOString(), ...meta });
  }

  /** The Claude session id, kept so a later call can resume this conversation. */
  session(id: string): void {
    if (!id || id === this.sessionId) return;
    this.sessionId = id;
    this.#append({ type: "session", sessionId: id });
  }

  /** Record one event passing through the socket. Unknown and token-level types are skipped. */
  log(m: Record<string, any>): void {
    const turn = typeof m.turn === "number" ? m.turn : 0;
    switch (m.type) {
      case "turn":
        this.#turn(turn).you = String(m.text ?? "");
        return this.#append({ type: "turn", turn, you: m.text });
      case "transcript":
        return this.#append({ type: "heard", text: m.text, ms: m.ms, error: m.error });
      case "say":
        this.#turn(turn).said.push(String(m.text ?? ""));
        return this.#append({ type: "say", turn, text: m.text });
      case "narrate":
        return this.#append({ type: "narrate", turn, text: m.text });
      case "screen":
        this.#turn(turn).screen += String(m.text ?? "");
        return this.#append({ type: "screen", turn, text: m.text });
      case "tool":
        this.#turn(turn).tools.push(String(m.label ?? ""));
        return this.#append({ type: "tool", turn, id: m.id, label: m.label, detail: trim(m.detail, 600) });
      case "tool_result":
        return this.#append({ type: "tool_result", turn, id: m.id, ok: m.ok, summary: m.summary });
      case "error":
        this.#turn(turn).errors.push(String(m.text ?? ""));
        return this.#append({ type: "error", turn, text: m.text });
      case "done":
        return this.#append({ type: "done", turn, interrupted: !!m.interrupted });
      // what Ada set in motion, and how it went: the record a "she said it but nothing happened"
      // needs (before, actions left no trace here at all)
      case "action":
        return this.#append({ type: "action", turn, name: m.name, attrs: m.attrs, brief: trim(m.body, 300) });
      case "action-result":
        return this.#append({ type: "action-result", turn, name: m.name, ok: m.ok, text: m.text });
      default:
        return; // stt readiness, thinking and working notes are not part of the call record
    }
  }

  /** Finish the JSONL and write the readable transcript. Safe to call twice. */
  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.#append({ type: "call-end", seconds: Math.round((Date.now() - this.started) / 1000) });
    const md = this.#markdown();
    this.chain = this.chain.then(() => writeFile(this.mdPath, md)).catch((e) => console.error("transcript:", e));
    await this.chain;
  }

  #turn(n: number): Turn {
    let t = this.turns.find((x) => x.n === n);
    if (!t) this.turns.push((t = { n, you: "", said: [], tools: [], screen: "", errors: [] }));
    return t;
  }

  #append(line: object): void {
    const text = JSON.stringify({ t: Date.now() - this.started, ...line }) + "\n";
    this.chain = this.chain
      .then(() => mkdir(this.dir, { recursive: true }))
      .then(() => appendFile(this.jsonlPath, text))
      .catch((e) => console.error("transcript:", e));
  }

  #markdown(): string {
    const secs = Math.round((Date.now() - this.started) / 1000);
    const head = [
      `- Length: ${Math.floor(secs / 60)}m ${secs % 60}s`,
      ...Object.entries(this.meta).map(([k, v]) => `- ${k}: \`${v}\``),
      ...(this.sessionId ? [`- Claude session: \`${this.sessionId}\``] : []),
    ];
    const parts = [`# Buddy call · ${new Date(this.started).toLocaleString()}`, head.join("\n")];
    for (const t of this.turns.filter((x) => x.you || x.said.length || x.tools.length)) {
      parts.push(`## ${t.n}. You: ${t.you || "(no words)"}`);
      if (t.said.length) parts.push(`**Buddy said:** ${t.said.join(" ")}`);
      if (t.tools.length) parts.push(`**Did:** ${t.tools.join(" · ")}`);
      const screen = t.screen.trim();
      if (screen) parts.push(`**On screen:**\n\n${screen}`);
      for (const e of t.errors) parts.push(`**Problem:** ${e}`);
    }
    return parts.join("\n\n") + "\n";
  }
}

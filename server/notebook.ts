import { readFileSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * What Ada keeps from one call to the next.
 *
 * Her conversation itself starts fresh with every run of the app: it is mostly routing — "go to
 * Juno", "pause", "who's waiting" — and carrying all of it forward would bury what matters under
 * chatter. What matters is short and is kept here instead:
 *   - what happened on the team: projects set up, work handed out, projects closed;
 *   - where each project stands: its last report, one line per project, replaced as it changes;
 *   - what the lead asked her to remember: preferences and decisions (her <remember> tag).
 * She is shown it at the start of each conversation. The project agents need none of this: each
 * keeps its own Claude session, which holds its work in full.
 */
export interface NotebookData {
  /** Things the lead asked to be remembered, oldest first. */
  notes: string[];
  /** What happened, oldest first, each with its date. */
  events: string[];
  /** Project name -> its last report. */
  status: Record<string, string>;
}

const MAX_NOTES = 30;
const MAX_EVENTS = 30;
const MAX_LINE = 200;

const line = (s: string) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > MAX_LINE ? `${t.slice(0, MAX_LINE - 1)}…` : t;
};
const today = () => new Date().toISOString().slice(0, 10);

export class Notebook {
  private data: NotebookData = { notes: [], events: [], status: {} };
  private saving: Promise<void> = Promise.resolve();
  private file?: string;

  /** No file: kept only for this run (tests). */
  constructor(file?: string) {
    this.file = file;
    if (!file) return;
    try {
      const d = JSON.parse(readFileSync(file, "utf8"));
      this.data = { notes: d.notes ?? [], events: d.events ?? [], status: d.status ?? {} };
    } catch {}
  }

  /** Something the lead wants kept. A note already there is not added twice. */
  remember(text: string): void {
    const t = line(text);
    if (!t) return;
    this.data.notes = [...this.data.notes.filter((n) => n.toLowerCase() !== t.toLowerCase()), t].slice(-MAX_NOTES);
    this.save();
  }

  /** Drop notes that mention `text`: how "forget that" works. Returns how many went. */
  forget(text: string): number {
    const k = text.trim().toLowerCase();
    if (!k) return 0;
    const before = this.data.notes.length;
    this.data.notes = this.data.notes.filter((n) => !n.toLowerCase().includes(k));
    if (this.data.notes.length !== before) this.save();
    return before - this.data.notes.length;
  }

  /** Something that happened on the team. */
  log(text: string): void {
    const t = line(text);
    if (!t) return;
    this.data.events = [...this.data.events, `${today()}: ${t}`].slice(-MAX_EVENTS);
    this.save();
  }

  /** A project's latest report, or null when it has gone. */
  status(name: string, report: string | null): void {
    if (report === null) delete this.data.status[name];
    else if (report.trim()) this.data.status[name] = line(report);
    else return;
    this.save();
  }

  /** The notebook as Ada is shown it, or "" when there is nothing in it. */
  text(): string {
    const parts: string[] = [];
    if (this.data.notes.length) parts.push(`the lead asked you to remember: ${this.data.notes.join("; ")}`);
    const st = Object.entries(this.data.status);
    if (st.length) parts.push(`where projects stood: ${st.map(([n, r]) => `${n}: "${r}"`).join("; ")}`);
    if (this.data.events.length) parts.push(`recently: ${this.data.events.slice(-12).join("; ")}`);
    return parts.length ? `[from earlier calls — ${parts.join(". ")}]` : "";
  }

  /** Resolves once everything changed so far is on disk. */
  flush(): Promise<void> {
    return this.saving;
  }

  get snapshot(): NotebookData {
    return structuredClone(this.data);
  }

  private save(): void {
    const file = this.file;
    if (!file) return;
    const body = JSON.stringify(this.data, null, 2);
    this.saving = this.saving.then(async () => {
      await mkdir(dirname(file), { recursive: true });
      await writeFile(file, body);
    }).catch(() => {});
  }
}

/**
 * What changed on the team since Ada was last told, as one bracketed line. Each turn she used to
 * get the whole roster again — two thirds of every message, the same words each time — which
 * crowded her conversation and made real changes easy to miss. Now she gets it whole at the start
 * (and after her conversation is summarised), then only what is different.
 * `before` and `now` map a project id to its one-line description.
 */
export function teamChanges(before: Map<string, string>, now: Map<string, string>): string {
  const bits: string[] = [];
  for (const [id, d] of now) if (before.get(id) !== d) bits.push(before.has(id) ? d : `new: ${d}`);
  for (const [id, d] of before) if (!now.has(id)) bits.push(`gone: ${d.split(" (id ")[0]}`);
  return bits.length ? `[team changes since your last message: ${bits.join("; ")}]` : "";
}

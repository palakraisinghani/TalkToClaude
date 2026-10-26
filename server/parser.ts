import { splitSentences } from "./cleaner.ts";

export type ParsedEvent =
  | { kind: "sentence"; text: string }
  | { kind: "screen"; text: string }
  | { kind: "aside"; text: string }
  | { kind: "fallback"; text: string }
  /** A whole <question> block, once it closes. Its sentences are also emitted as speech. */
  | { kind: "question"; text: string }
  /** A control tag such as <open path="…"/> or <delegate to="rex">…</delegate>. */
  | { kind: "action"; name: ActionName; attrs: Record<string, string>; body: string; text: string };

export type ActionName = "open" | "new" | "switch" | "delegate" | "park" | "close" | "handoff" | "voice" | "call" | "setting" | "remember" | "forget" | "control";

type Section = "none" | "say" | "screen" | "question";
export const ALL_ACTIONS: ActionName[] = ["open", "new", "switch", "delegate", "park", "close", "handoff", "voice", "call", "setting", "remember", "forget", "control"];
/**
 * How far an action tag's opening may run without its ">" before it is taken to be ordinary text.
 * Its body — a brief — may be far longer (BODY_MAX): briefs for new agents run 1,000–1,600
 * characters, and a 600-character limit here once threw every one of them away without a word.
 */
const ACTION_MAX = 600;
/** A body longer than this without its closing tag is not a brief but runaway text. */
const BODY_MAX = 40_000;
// long enough to hold back the start of the longest tag name, "<question" or "<delegate "
const HOLD = 12;

function attrs(raw: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of raw.matchAll(/([\w-]+)\s*=\s*"([^"]*)"/g)) out[m[1].toLowerCase()] = m[2];
  return out;
}

/**
 * Streaming parser for conversational replies. Any number of <say> blocks are spoken
 * sentence by sentence as they close; <screen> goes to the panel; text outside tags is
 * the agent working aloud and goes to the behind-the-scenes feed.
 * <question> is spoken like <say>, and also reported whole, so a project working in the
 * background can put a question to the person through the central voice.
 * Action tags are passed on whole, never spoken. Most are the central agent's; any agent may use
 * <handoff>, to put the lead through to someone else with a note.
 * If no <say> appears all turn, end() yields one fallback event with the outside text.
 */
export class ReplyParser {
  private open: RegExp;
  /**
   * `actions`: which control tags this agent may use. The central agent uses them all; a project
   * agent only <handoff>, so one that talks about "the <close> button" is just talking.
   */
  constructor({ actions = ALL_ACTIONS }: { actions?: ActionName[] } = {}) {
    const names = actions.length ? `|<(${actions.join("|")})(?=[\\s/>])` : "";
    this.open = new RegExp(`<(say|screen|question)>${names}`);
  }
  private buf = "";
  private outside = "";
  private section: Section = "none";
  private sawSay = false;
  private pending = "";
  private question = "";

  feed(delta: string): ParsedEvent[] {
    this.buf += delta;
    const out: ParsedEvent[] = [];
    for (;;) {
      if (this.section === "none") {
        const m = this.open.exec(this.buf);
        let chunk: string;
        if (m) chunk = this.buf.slice(0, m.index);
        else {
          // hold back a possible partial opening tag
          const lt = this.buf.lastIndexOf("<");
          const hold = lt >= 0 && this.buf.length - lt < HOLD ? lt : this.buf.length;
          chunk = this.buf.slice(0, hold);
        }
        if (chunk) { this.outside += chunk; out.push({ kind: "aside", text: chunk }); }
        if (!m) { this.buf = this.buf.slice(chunk.length); break; }
        this.buf = this.buf.slice(m.index);
        if (m[2]) {
          // an action tag is only acted on once it is complete, so wait for the rest of it
          const action = this.action(m[2] as ActionName);
          if (!action) break;
          if (action.kind === "aside") this.outside += action.text;
          out.push(action);
          continue;
        }
        this.section = m[1] as Section;
        if (this.section !== "screen") this.sawSay = true;
        this.buf = this.buf.slice(m[0].length);
        continue;
      }
      const close = `</${this.section}>`;
      const i = this.buf.indexOf(close);
      let chunk: string;
      const closed = i >= 0;
      if (closed) { chunk = this.buf.slice(0, i); this.buf = this.buf.slice(i + close.length); }
      else {
        const keep = Math.min(this.buf.length, close.length - 1);
        chunk = this.buf.slice(0, this.buf.length - keep);
        this.buf = this.buf.slice(this.buf.length - keep);
      }
      if (this.section === "say" || this.section === "question") {
        if (this.section === "question") this.question += chunk;
        this.pending += chunk;
        const { sentences, rest } = splitSentences(this.pending);
        this.pending = rest;
        for (const s of sentences) out.push({ kind: "sentence", text: s });
        if (closed && this.pending.trim()) out.push({ kind: "sentence", text: this.pending.trim() });
        if (closed) this.pending = "";
        if (closed && this.section === "question") {
          const q = this.question.replace(/\s+/g, " ").trim();
          this.question = "";
          if (q) out.push({ kind: "question", text: q });
        }
      } else if (chunk) out.push({ kind: "screen", text: chunk });
      if (closed) { this.section = "none"; continue; }
      break;
    }
    return out;
  }

  /**
   * A complete action tag at the start of the buffer, consumed; null while it is still arriving.
   * One that never closes — too long, or speech starting before its end — was not an action after
   * all: its opening is let go as ordinary text, so nothing after it is held back for ever.
   */
  private action(name: ActionName): ParsedEvent | null {
    const notAnAction = (upTo: number): ParsedEvent => {
      const text = this.buf.slice(0, upTo);
      this.buf = this.buf.slice(upTo);
      return { kind: "aside", text };
    };
    const gt = this.buf.indexOf(">");
    if (gt < 0) return this.buf.length > ACTION_MAX ? notAnAction(1) : null;
    const head = this.buf.slice(1 + name.length, gt);
    let body = "";
    let end = gt + 1;
    if (!head.trimEnd().endsWith("/")) {
      const close = `</${name}>`;
      const i = this.buf.indexOf(close, end);
      if (i < 0) {
        // speech starting first means it was prose that mentioned a tag, not a tag (agents close
        // theirs: measured on real calls, 36 of 37); otherwise wait for the close, however long
        const speech = this.buf.indexOf("<say>", end);
        return speech >= 0 || this.buf.length - end > BODY_MAX ? notAnAction(end) : null;
      }
      body = this.buf.slice(end, i).trim();
      end = i + close.length;
    }
    const text = this.buf.slice(0, end);
    this.buf = this.buf.slice(end);
    return { kind: "action", name, attrs: attrs(head), body, text };
  }

  /**
   * An action tag still being written: its name and attributes once its opening is complete.
   * What an interrupted reply was in the middle of, so the agent can be told it did not happen.
   */
  unfinished(): { name: ActionName; attrs: Record<string, string> } | null {
    const m = this.open.exec(this.buf);
    if (!m || m.index !== 0) return null;
    const name = (m[2] ?? "") as ActionName; // m[1] is a <say>-like section, not an action
    const gt = this.buf.indexOf(">");
    if (!name || gt < 0) return null;
    return { name, attrs: attrs(this.buf.slice(1 + name.length, gt)) };
  }

  end(): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    const tail = (this.pending + this.buf).trim();
    if ((this.section === "say" || this.section === "question") && tail) {
      out.push({ kind: "sentence", text: tail });
      if (this.section === "question") out.push({ kind: "question", text: (this.question + this.buf).replace(/\s+/g, " ").trim() });
    } else if (this.section === "screen" && this.buf) out.push({ kind: "screen", text: this.buf });
    else if (this.section === "none" && this.buf) this.outside += this.buf;
    if (!this.sawSay && this.outside.trim()) out.push({ kind: "fallback", text: this.outside });
    return out;
  }
}

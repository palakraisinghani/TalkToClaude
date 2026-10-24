import { splitSentences } from "./cleaner.ts";

export type ParsedEvent =
  | { kind: "sentence"; text: string }
  | { kind: "screen"; text: string }
  | { kind: "aside"; text: string }
  | { kind: "fallback"; text: string };

type Section = "none" | "say" | "screen";
const OPEN = /<(say|screen)>/;

/**
 * Streaming parser for conversational replies. Any number of <say> blocks are spoken
 * sentence by sentence as they close; <screen> goes to the panel; text outside tags is
 * the agent working aloud and goes to the behind-the-scenes feed.
 * If no <say> appears all turn, end() yields one fallback event with the outside text.
 */
export class ReplyParser {
  private buf = "";
  private outside = "";
  private section: Section = "none";
  private sawSay = false;
  private pending = "";

  feed(delta: string): ParsedEvent[] {
    this.buf += delta;
    const out: ParsedEvent[] = [];
    for (;;) {
      if (this.section === "none") {
        const m = OPEN.exec(this.buf);
        let chunk: string;
        if (m) chunk = this.buf.slice(0, m.index);
        else {
          // hold back a possible partial opening tag
          const lt = this.buf.lastIndexOf("<");
          const hold = lt >= 0 && this.buf.length - lt < 8 ? lt : this.buf.length;
          chunk = this.buf.slice(0, hold);
        }
        if (chunk) { this.outside += chunk; out.push({ kind: "aside", text: chunk }); }
        if (!m) { this.buf = this.buf.slice(chunk.length); break; }
        this.section = m[1] as Section;
        if (this.section === "say") this.sawSay = true;
        this.buf = this.buf.slice(m.index + m[0].length);
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
      if (this.section === "say") {
        this.pending += chunk;
        const { sentences, rest } = splitSentences(this.pending);
        this.pending = rest;
        for (const s of sentences) out.push({ kind: "sentence", text: s });
        if (closed && this.pending.trim()) out.push({ kind: "sentence", text: this.pending.trim() });
        if (closed) this.pending = "";
      } else if (chunk) out.push({ kind: "screen", text: chunk });
      if (closed) { this.section = "none"; continue; }
      break;
    }
    return out;
  }

  end(): ParsedEvent[] {
    const out: ParsedEvent[] = [];
    if (this.section === "say" && (this.pending + this.buf).trim()) out.push({ kind: "sentence", text: (this.pending + this.buf).trim() });
    else if (this.section === "screen" && this.buf) out.push({ kind: "screen", text: this.buf });
    else if (this.section === "none" && this.buf) this.outside += this.buf;
    if (!this.sawSay && this.outside.trim()) out.push({ kind: "fallback", text: this.outside });
    return out;
  }
}

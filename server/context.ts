import type { Mode } from "./types.ts";

/** What the listener had heard when they cut in, as reported by the page. */
export interface CallContext {
  /** "paused": the user said pause first; "interrupted": they talked over the reply; "followup": they added something while it worked silently. */
  kind: "paused" | "interrupted" | "followup";
  /** The running work was left going, and this message waited for it to finish. */
  queued?: boolean;
  /** This replaces the message queued just before it: the second half of the same sentence. */
  replace?: boolean;
  /** The last words Buddy spoke before stopping. */
  heard?: string;
  /** Sentences queued or still being written that the user never heard. */
  unheard?: string[];
  /** How long ago the user paused, in ms. */
  pausedMs?: number;
  /** Whether Claude was still working when the user cut in. */
  working?: boolean;
}

const quote = (s: string, max = 160) => {
  const t = s.replace(/\s+/g, " ").trim();
  return `"${t.length > max ? "…" + t.slice(-max) : t}"`;
};

/** Short bracketed note prepended to the user's words so Claude knows where the call stands. */
export function formatContext(mode: Mode, ctx?: CallContext | null, onTheLine = true): string {
  return [callHeader(mode, onTheLine), cutIn(ctx)].filter(Boolean).join(" ");
}

/** Where the agent is on the call. The same turn after turn, so it is only sent when it changes. */
export function callHeader(mode: Mode, onTheLine = true, canvas = ""): string {
  // the canvas's size, so diagrams and pictures are drawn to fit it (visual calls only)
  const room = mode !== "audio" && canvas ? ` · canvas ${canvas} px` : "";
  return `[call · ${mode === "audio" ? "audio-only" : "visual+audio"} · ${onTheLine ? "you are on the line" : "you are in the background, your words are not spoken"}${room}]`;
}

/** What the listener had heard when they cut in: about this message alone, so always sent. */
export function cutIn(ctx?: CallContext | null): string {
  const parts: string[] = [];
  if (ctx) {
    const bits: string[] = [];
    if (ctx.kind === "paused") {
      const secs = Math.round((ctx.pausedMs ?? 0) / 1000);
      bits.push(`the user said pause${secs >= 2 ? ` ${secs}s ago` : ""}`);
    } else if (ctx.kind === "followup") bits.push("the user said this while you were working");
    else bits.push("the user talked over you");
    if (ctx.heard) bits.push(`the last thing they heard was ${quote(ctx.heard)}`);
    const unheard = (ctx.unheard ?? []).filter(Boolean);
    if (unheard.length) bits.push(`they did not hear ${unheard.length} more sentence${unheard.length > 1 ? "s" : ""}: ${quote(unheard.join(" "), 240)}`);
    if (ctx.queued) bits.push("your previous work was not stopped and has now finished; do not redo it, answer this");
    else if (ctx.working) bits.push("your previous work was stopped");
    parts.push(`[cut in: ${bits.join("; ")}]`);
  }
  return parts.join(" ");
}

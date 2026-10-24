import type { Mode } from "./types.ts";

/** What the listener had heard when they cut in, as reported by the page. */
export interface CallContext {
  /** "paused": the user said pause first; "interrupted": they talked over the reply. */
  kind: "paused" | "interrupted";
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
export function formatContext(mode: Mode, ctx?: CallContext | null): string {
  const parts = [`[call · ${mode === "audio" ? "audio-only" : "visual+audio"}]`];
  if (ctx) {
    const bits: string[] = [];
    if (ctx.kind === "paused") {
      const secs = Math.round((ctx.pausedMs ?? 0) / 1000);
      bits.push(`the user said pause${secs >= 2 ? ` ${secs}s ago` : ""}`);
    } else bits.push("the user talked over you");
    if (ctx.heard) bits.push(`the last thing they heard was ${quote(ctx.heard)}`);
    const unheard = (ctx.unheard ?? []).filter(Boolean);
    if (unheard.length) bits.push(`they did not hear ${unheard.length} more sentence${unheard.length > 1 ? "s" : ""}: ${quote(unheard.join(" "), 240)}`);
    if (ctx.working) bits.push("your previous work was stopped");
    parts.push(`[cut in: ${bits.join("; ")}]`);
  }
  return parts.join(" ");
}

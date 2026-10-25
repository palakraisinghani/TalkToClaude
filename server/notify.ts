/**
 * What the assistant says on a project's behalf, when the lead asks to hear it. Plain facts: how to
 * answer is up to the page, which knows whether the lead is listening for an answer right now.
 *
 * What the central voice says on a project's behalf. Only one project is ever on the line, so
 * everything the others need to tell you arrives here and is read out by the central voice,
 * always naming the project first so you know who it is about before you know what it is.
 */

export type NotifyKind = "permission" | "question" | "finished" | "failed" | "blocked";

export interface Notification {
  project: string; // project id
  name: string; // the name said out loud
  kind: NotifyKind;
  text: string; // the line the central voice says
  detail: string; // the longer version for the panel
  at: number;
}

/** Plain words for what a tool would have done, for the permission request. */
export function permissionPhrase(tool: string): string {
  switch (tool) {
    case "Write": return "create a file";
    case "Edit": case "NotebookEdit": return "change a file";
    case "Bash": return "run a command";
    case "WebFetch": case "WebSearch": return "go online";
    case "Task": case "Agent": return "start a helper";
    default: return `use ${tool}`;
  }
}

const base = (p: unknown) => String(p ?? "").split("/").filter(Boolean).pop() ?? "";
const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1).replace(/\.$/, "");

/**
 * What a paused action would do, in words for the ear and in full for the screen. The tool's own
 * description is used when it has one ("Install dependencies"), because that is what a person
 * would say; the exact command or path always goes on screen, never into speech.
 */
export function describeAction(tool: string, input: any): { phrase: string; detail: string } {
  const i = input ?? {};
  switch (tool) {
    case "Bash":
      return { phrase: i.description ? lower(String(i.description)) : "run a command", detail: String(i.command ?? "") };
    case "Write":
      return { phrase: `create ${base(i.file_path) || "a file"}`, detail: String(i.file_path ?? "") };
    case "Edit": case "MultiEdit": case "NotebookEdit":
      return { phrase: `change ${base(i.file_path ?? i.notebook_path) || "a file"}`, detail: String(i.file_path ?? i.notebook_path ?? "") };
    case "WebFetch": {
      let host = "";
      try { host = new URL(String(i.url)).hostname; } catch {}
      return { phrase: host ? `open a page on ${host}` : "go online", detail: String(i.url ?? "") };
    }
    case "WebSearch":
      return { phrase: "search the web", detail: String(i.query ?? "") };
    default:
      return { phrase: permissionPhrase(tool), detail: JSON.stringify(i).slice(0, 400) };
  }
}

/**
 * The narrowest permission rule that allows exactly this action and nothing else: one command,
 * one file, one site. Used when the lead says yes to something the safety check refused.
 */
export function ruleFor(tool: string, input: any): string | null {
  const i = input ?? {};
  switch (tool) {
    case "Bash": return i.command ? `Bash(${String(i.command)})` : null;
    case "Write": case "Edit": case "MultiEdit": return i.file_path ? `${tool === "Write" ? "Write" : "Edit"}(${String(i.file_path)})` : null;
    case "NotebookEdit": return i.notebook_path ? `NotebookEdit(${String(i.notebook_path)})` : null;
    case "WebFetch": {
      try { return `WebFetch(domain:${new URL(String(i.url)).hostname})`; } catch { return null; }
    }
    default: return null;
  }
}

/** The first sentence of what a project said last, used as its own one-line report. */
export function summarise(said: string[]): string {
  const last = [...said].reverse().find((s) => s.trim());
  if (!last) return "";
  return sayable((last.match(/[^.!?]+[.!?]?/) ?? [last])[0].trim());
}

/**
 * Shorten something that will be spoken. Cut at a sentence or a whole word, never mid-word, and
 * never with an ellipsis: a voice reads "plu…" as "plu", which sounds like a glitch, not a pause.
 */
export function sayable(text: string, max = 240): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const sentence = cut.match(/^.*[.!?](?=\s)/)?.[0];
  if (sentence && sentence.length > max / 2) return sentence;
  return cut.replace(/[\s,;:—-]+\S*$/, "").replace(/[,;:—-]+$/, "") + ".";
}

export function notification(kind: NotifyKind, name: string, project: string, info: { tool?: string; message?: string; said?: string[]; question?: string; phrase?: string } = {}): Notification {
  const summary = summarise(info.said ?? []);
  let text: string;
  let detail: string;
  if (kind === "permission") {
    const phrase = info.phrase || permissionPhrase(info.tool ?? "a tool");
    text = `${name} wants to ${phrase}.`;
    detail = info.message || `${name} wants to ${phrase}.`;
  } else if (kind === "blocked") {
    const phrase = info.phrase || permissionPhrase(info.tool ?? "a tool");
    text = `The safety check stopped ${name} from trying to ${phrase}. ${name} will carry on without it.`;
    detail = info.message || "";
  } else if (kind === "question") {
    const q = (info.question ?? "").trim();
    text = `${name} asks: ${q}`;
    detail = q;
  } else if (kind === "failed") {
    text = `${name} hit a problem.${summary ? ` ${summary}` : ""}`;
    detail = info.message || summary;
  } else {
    text = summary ? `${name} has finished. ${summary}` : `${name} has finished.`;
    detail = summary;
  }
  return { project, name, kind, text, detail, at: Date.now() };
}

/**
 * Several things finished while you were talking: say how many, then the most important two.
 * Permission requests and questions come first, because they are the ones that are blocking.
 */
export function batch(pending: Notification[]): string {
  const rank = { permission: 0, question: 1, blocked: 2, failed: 3, finished: 4 } as const;
  const sorted = [...pending].sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at);
  if (sorted.length === 1) return sorted[0].text;
  const head = sorted.slice(0, 2).map((n) => n.text.replace(/\.$/, ""));
  const rest = sorted.length - 2;
  return `${sorted.length} updates. ${head.join(". And ")}.${rest > 0 ? ` And ${rest} more on screen.` : ""}`;
}

/**
 * What the central voice says on a project's behalf. Only one project is ever on the line, so
 * everything the others need to tell you arrives here and is read out by the central voice,
 * always naming the project first so you know who it is about before you know what it is.
 */

export type NotifyKind = "permission" | "finished" | "failed";

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

/** The first sentence of what a project said last, used as its own one-line report. */
export function summarise(said: string[]): string {
  const last = [...said].reverse().find((s) => s.trim());
  if (!last) return "";
  const first = (last.match(/[^.!?]+[.!?]?/) ?? [last])[0].trim();
  return first.length > 140 ? first.slice(0, 139) + "…" : first;
}

export function notification(kind: NotifyKind, name: string, project: string, info: { tool?: string; message?: string; said?: string[] } = {}): Notification {
  const summary = summarise(info.said ?? []);
  let text: string;
  let detail: string;
  if (kind === "permission") {
    const phrase = permissionPhrase(info.tool ?? "a tool");
    text = `${name} needs permission to ${phrase}. Say allow ${name}, or leave it.`;
    detail = info.message || `${name} wants to ${phrase}.`;
  } else if (kind === "failed") {
    text = `${name} hit a problem.${summary ? ` ${summary}` : ""}`;
    detail = info.message || summary;
  } else {
    text = summary ? `${name} is done. ${summary}` : `${name} is done.`;
    detail = summary;
  }
  return { project, name, kind, text, detail, at: Date.now() };
}

/**
 * Several things finished while you were talking: say how many, then the most important two.
 * Permission requests come first, because they are the only ones that are blocking.
 */
export function batch(pending: Notification[]): string {
  const rank = { permission: 0, failed: 1, finished: 2 } as const;
  const sorted = [...pending].sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at);
  if (sorted.length === 1) return sorted[0].text;
  const head = sorted.slice(0, 2).map((n) => n.text.replace(/\.$/, ""));
  const rest = sorted.length - 2;
  return `${sorted.length} updates. ${head.join(". And ")}.${rest > 0 ? ` And ${rest} more on screen.` : ""}`;
}

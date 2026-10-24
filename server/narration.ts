const base = (p: unknown) => {
  const s = typeof p === "string" ? p : "";
  return (s.split("/").pop() ?? s).replace(/\./g, " dot ");
};

/** Short fixed phrase for a tool_use event, spoken while Claude works. */
export function narrate(name: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Read": return `reading ${base(i.file_path)}`;
    case "Grep": return typeof i.pattern === "string" ? `searching for ${i.pattern.replace(/[^\w ]/g, " ").trim()}` : "searching";
    case "Glob": return "looking for files";
    case "Bash": return "running a command";
    case "WebSearch": case "WebFetch": return "checking the web";
    case "Task": case "Agent": return "asking a helper";
    case "ExitPlanMode": case "TodoWrite": case "Skill": case "ToolSearch": return null;
    default: return "working on it";
  }
}

const short = (s: unknown, n = 48) => {
  const t = typeof s === "string" ? s.replace(/\s+/g, " ").trim() : "";
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const file = (p: unknown) => (typeof p === "string" ? p.split("/").pop() ?? p : "");

/** The interesting part of a tool call's input, verbatim, for the expandable card. */
export function toolDetail(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : "");
  const lines = (prefix: string, v: unknown) => str(v).split("\n").map((l) => prefix + l).join("\n");
  if (name === "Bash") return "$ " + str(i.command);
  if (name === "Edit") return `${str(i.file_path)}\n${lines("- ", i.old_string)}\n${lines("+ ", i.new_string)}`;
  if (name === "Write") return `${str(i.file_path)}\n${str(i.content).slice(0, 3000)}`;
  return "";
}

/** Compact on-screen label for a tool card, e.g. "Read · auth.ts". */
export function toolLabel(name: string, input: unknown): string {
  const i = (input ?? {}) as Record<string, unknown>;
  const detail =
    i.file_path ? file(i.file_path) :
    i.notebook_path ? file(i.notebook_path) :
    name === "Bash" ? short(i.description || i.command) :
    i.pattern ? `“${short(i.pattern, 32)}”` :
    i.query ? `“${short(i.query, 32)}”` :
    i.url ? short(i.url) :
    i.description ? short(i.description) : "";
  return detail ? `${name} · ${detail}` : name;
}

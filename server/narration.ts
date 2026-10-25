const base = (p: unknown) => {
  const s = typeof p === "string" ? p : "";
  return (s.split("/").pop() ?? s).replace(/\./g, " dot ");
};

/**
 * A short spoken update for a tool an agent is using: what it is actually doing, in a few words —
 * "installing the packages", "writing a Python script, scraper", "downloading the dataset" — not
 * "running a command". Claude Code's shell tool carries a description of each command ("Install
 * dependencies"); that is the best source, turned into "installing dependencies". Failing that, the
 * command or the file is recognised. Null for tools not worth a word.
 */
export function narrate(name: string, input: unknown): string | null {
  const i = (input ?? {}) as Record<string, unknown>;
  switch (name) {
    case "Read": return `reading ${base(i.file_path)}`;
    case "Grep": return typeof i.pattern === "string" ? `searching the code for ${i.pattern.replace(/[^\w ]/g, " ").replace(/\s+/g, " ").trim().slice(0, 40)}` : "searching the code";
    case "Glob": return "looking through the files";
    case "Bash": return commandUpdate(String(i.command ?? ""), typeof i.description === "string" ? i.description : "");
    case "Write": return fileUpdate(String(i.file_path ?? ""), "writing");
    case "Edit": case "MultiEdit": case "NotebookEdit": return fileUpdate(String(i.file_path ?? i.notebook_path ?? ""), "updating");
    case "WebSearch": return typeof i.query === "string" ? `searching the web for ${i.query.slice(0, 50)}` : "searching the web";
    case "WebFetch": { let host = ""; try { host = new URL(String(i.url)).hostname.replace(/^www\./, ""); } catch {} return host ? `reading a page on ${host.replace(/\./g, " dot ")}` : "reading a web page"; }
    case "Task": case "Agent": return typeof i.description === "string" && i.description ? `getting a helper to ${lower(i.description)}` : "getting a helper on it";
    case "TodoWrite": return "planning the steps";
    case "ExitPlanMode": case "Skill": case "ToolSearch": return null;
    default: return "working on it";
  }
}

const lower = (s: string) => s.charAt(0).toLowerCase() + s.slice(1).replace(/[.!]$/, "");

/** "Install dependencies" → "installing dependencies": the first word of an instruction, as -ing. */
export function gerund(phrase: string): string {
  const [first, ...rest] = phrase.trim().replace(/[.!]$/, "").split(/\s+/);
  if (!first) return "";
  const w = first.toLowerCase();
  const ing = /ing$/.test(w) ? w
    : /^(run|get|set|put|stop|plan|shut|cut|map|ship|drop|wrap|scan)$/.test(w) ? w + w.slice(-1) + "ing"
    : /ie$/.test(w) ? w.slice(0, -2) + "ying"
    : /[^e]e$/.test(w) && !/ee$/.test(w) ? w.slice(0, -1) + "ing"
    : w + "ing";
  return [ing, ...rest].join(" ");
}

/** What a shell command is doing, from its description or, failing that, the command itself. */
function commandUpdate(cmd: string, description: string): string {
  if (description) return gerund(description).slice(0, 80);
  const c = cmd.trim();
  const file = (re: RegExp) => base(re.exec(c)?.[1] ?? "").replace(/ dot \w+$/, "");
  if (/\b(pip3?|uv pip|poetry|npm|pnpm|yarn|bun|brew|apt(-get)?|cargo|gem|go)\s+(install|add|i)\b/.test(c)) return "installing the packages it needs";
  if (/\b(curl|wget)\b|\bgit\s+clone\b|\bhf\s+download\b|huggingface-cli\s+download/.test(c)) {
    const what = /(dataset|data|model|weights)/i.exec(c)?.[1];
    return what ? `downloading the ${what.toLowerCase()}` : "downloading what it needs";
  }
  if (/\b(pytest|jest|vitest|mocha|go test|cargo test|npm (run )?test|node --test|unittest)\b/.test(c)) return "running the tests";
  if (/\b(train|fit|finetune|fine_tune)\w*\.py\b|--epochs\b/.test(c)) return "training the model";
  if (/\bpython3?\s+(\S+\.py)/.test(c)) return `running the ${file(/python3?\s+(\S+\.py)/)} script`;
  if (/\b(npm run build|vite build|webpack|tsc\b|make\b|cargo build|go build)/.test(c)) return "building the project";
  if (/\b(npm run dev|npm start|vite\b|serve\b|http\.server|uvicorn|flask run)/.test(c)) return "starting the app";
  if (/\bgit\s+(commit|push|pull|merge|rebase|checkout|status|diff|log)\b/.test(c)) return `checking in with git`;
  if (/\b(ls|find|tree|du)\b/.test(c)) return "looking around the folder";
  if (/\b(cat|head|tail|less|grep|rg)\b/.test(c)) return "reading through the files";
  return "running a command";
}

/** What writing or changing a file is for, from its kind: "writing a Python script, scraper". */
function fileUpdate(path: string, verb: "writing" | "updating"): string {
  const f = path.split("/").pop() ?? "";
  const stem = f.replace(/\.[^.]+$/, "").replace(/[_-]+/g, " ");
  const ext = (/\.([^.]+)$/.exec(f)?.[1] ?? "").toLowerCase();
  const kinds: Record<string, string> = {
    py: `a Python script, ${stem}`, ipynb: `the ${stem} notebook`, js: `the ${stem} code`, ts: `the ${stem} code`, tsx: `the ${stem} component`, jsx: `the ${stem} component`,
    html: stem === "index" ? "the web page" : `the ${stem} page`, css: "the page's styles", scss: "the page's styles",
    md: `the ${stem} notes`, json: `the ${stem} settings`, yaml: `the ${stem} settings`, yml: `the ${stem} settings`, toml: `the ${stem} settings`,
    sh: `a shell script, ${stem}`, sql: `the ${stem} queries`, csv: `the ${stem} data`, txt: `${stem}`, go: `the ${stem} code`, rs: `the ${stem} code`, java: `the ${stem} code`,
  };
  const what = kinds[ext] ?? base(path);
  return verb === "writing" ? `writing ${what}` : `changing ${what}`;
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
  if (name === "TodoWrite" && Array.isArray(i.todos)) {
    const mark: Record<string, string> = { completed: "[x]", in_progress: "[~]" };
    return i.todos.map((t: any) => `${mark[t?.status] ?? "[ ]"} ${str(t?.content)}`).join("\n");
  }
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

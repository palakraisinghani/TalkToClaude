import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { ClaudeSession } from "./agent.ts";
import { clean } from "./cleaner.ts";
import { formatContext, type CallContext } from "./context.ts";
import { narrate, toolDetail, toolLabel } from "./narration.ts";
import { ReplyParser, type ParsedEvent } from "./parser.ts";
import { MoonshineSTT } from "./stt.ts";
import type { Mode, Rewriter } from "./types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const webDir = join(root, "web");
const workDir = resolve(process.env.BUDDY_CWD ?? join(root, "session"));
const PORT = Number(process.env.PORT ?? 3000);
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".onnx": "application/octet-stream",
};
// browser-side voice activity detection, served from node_modules so the page needs no CDN
const STATIC: [string, string][] = [
  ["/vendor/vad/", join(root, "node_modules", "@ricky0123", "vad-web", "dist")],
  ["/vendor/ort/", join(root, "node_modules", "onnxruntime-web", "dist")],
  ["/", webDir],
];
const FILLER_MS = 3500;
const NARRATE_GAP_MS = 6000;

const systemPrompt = ["VOICE.md", "examples.md", "condensation.md"]
  .map((f) => readFileSync(join(root, "skill", "claude-call", f), "utf8"))
  .join("\n\n");

const rewriter: Rewriter = { toSpeech: async (x) => x };

let sttState: "loading" | "ready" | "error" = "loading";
const stt = new MoonshineSTT();
const sockets = new Set<WebSocket>();
stt.ready().then(
  () => { sttState = "ready"; console.log("Speech recognition ready"); },
  (e) => { sttState = "error"; console.error("Speech recognition failed to load:", e); },
).finally(() => { for (const ws of sockets) ws.send(JSON.stringify({ type: "stt", state: sttState })); });

const http = createServer(async (req, res) => {
  try {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    const [prefix, dir] = STATIC.find(([p]) => url.startsWith(p))!;
    const file = resolve(dir, "." + normalize("/" + (url.slice(prefix.length) || "index.html")));
    if (!file.startsWith(dir)) throw new Error("outside");
    const body = await readFile(file);
    res.writeHead(200, { "content-type": TYPES[extname(file)] ?? "application/octet-stream", "cache-control": "no-cache" }).end(body);
  } catch {
    res.writeHead(404).end("not found");
  }
});

const wss = new WebSocketServer({ server: http });

wss.on("connection", (ws: WebSocket) => {
  sockets.add(ws);
  const send = (m: object) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  send({ type: "stt", state: sttState });

  let mode: Mode = "visual";
  let agent: ClaudeSession | null = null;
  let segmentId: string | null = null;
  // per-turn speech state
  const parsers = new Map<number, ReplyParser>();
  const parserFor = (turn: number) => parsers.get(turn) ?? parsers.set(turn, new ReplyParser()).get(turn)!;
  let lastSpokeAt = 0;
  let filler: ReturnType<typeof setTimeout> | undefined;
  // reply events go out strictly in order, even though cleaning is async
  let chain: Promise<unknown> = Promise.resolve();
  const inOrder = (fn: () => Promise<unknown> | void) => (chain = chain.then(fn).catch((e) => console.error(e)));

  const say = async (turn: number, text: string) => {
    const s = clean(await rewriter.toSpeech(text), mode);
    if (!s) return;
    lastSpokeAt = Date.now();
    clearTimeout(filler);
    send({ type: "say", turn, text: s });
  };

  const handleParsed = async (turn: number, events: ParsedEvent[]) => {
    for (const e of events) {
      if (e.kind === "sentence") await say(turn, e.text);
      else if (e.kind === "screen") send({ type: "screen", turn, text: e.text });
      else if (e.kind === "aside") send({ type: "aside", turn, text: e.text });
      else {
        // no <say> at all: speak the opening of the reply and put the whole thing on screen
        const parts = clean(e.text, mode).match(/[^.!?]+[.!?]*/g) ?? [];
        for (const s of parts.slice(0, 2)) await say(turn, s.trim());
        if (parts.length > 2) send({ type: "screen", turn, text: e.text });
      }
    }
  };

  function ensureAgent() {
    if (agent) return agent;
    const a = new ClaudeSession({ cwd: workDir, systemPrompt, permissionMode: process.env.BUDDY_PERMISSION_MODE ?? "auto" });
    a.on((turn, ev) => inOrder(async () => {
      switch (ev.kind) {
        case "text": await handleParsed(turn, parserFor(turn).feed(ev.text)); break;
        case "thinking": send({ type: "thinking", turn, text: ev.text }); break;
        case "tool": {
          send({ type: "tool", turn, id: ev.id, label: toolLabel(ev.name, ev.input), detail: toolDetail(ev.name, ev.input) });
          const n = narrate(ev.name, ev.input);
          if (n && Date.now() - lastSpokeAt > NARRATE_GAP_MS) { lastSpokeAt = Date.now(); clearTimeout(filler); send({ type: "narrate", turn, text: n }); }
          break;
        }
        case "tool_result": send({ type: "tool_result", turn, id: ev.id, ok: ev.ok, summary: ev.summary, detail: ev.detail }); break;
        case "error": send({ type: "error", turn, text: `Buddy hit a problem: ${ev.message}` }); break;
        case "done":
          clearTimeout(filler);
          if (!ev.interrupted) await handleParsed(turn, parserFor(turn).end());
          parsers.delete(turn);
          send({ type: "done", turn, interrupted: ev.interrupted || undefined });
          break;
      }
    }));
    a.start(); // warm the process before the first question
    agent = a;
    return a;
  }

  function startTurn(text: string, ctx?: CallContext | null) {
    const a = ensureAgent();
    const prompt = `${formatContext(mode, ctx)} ${text}`;
    const turn = a.send(prompt);
    lastSpokeAt = 0;
    clearTimeout(filler);
    filler = setTimeout(() => { if (!lastSpokeAt) { lastSpokeAt = Date.now(); send({ type: "narrate", turn, text: "One sec." }); } }, FILLER_MS);
    send({ type: "turn", turn, text });
  }

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) {
      const id = segmentId;
      segmentId = null;
      if (!id) return;
      const buf = raw as Buffer;
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      const audio = Float32Array.from(pcm, (x) => x / 32768);
      try {
        const t = Date.now();
        const text = await stt.transcribe(audio);
        send({ type: "transcript", id, text, ms: Date.now() - t });
      } catch (e) {
        send({ type: "transcript", id, text: "", error: (e as Error).message });
      }
      return;
    }
    let m: any;
    try { m = JSON.parse(String(raw)); } catch { return; }
    if (m.mode === "audio" || m.mode === "visual") mode = m.mode;
    if (m.type === "call-start") ensureAgent();
    else if (m.type === "segment") segmentId = String(m.id);
    else if (m.type === "utterance" && typeof m.text === "string" && m.text.trim()) startTurn(m.text.trim(), m.context);
    else if (m.type === "interrupt") { clearTimeout(filler); agent?.interrupt(); }
    else if (m.type === "call-end") { clearTimeout(filler); agent?.close(); agent = null; }
  });
  ws.on("close", () => { sockets.delete(ws); clearTimeout(filler); agent?.close(); });
});

http.listen(PORT, () => console.log(`Buddy is on http://localhost:${PORT} (open in Chrome or Edge) · working in ${workDir}`));

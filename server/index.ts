import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Auth } from "./auth.ts";
import { Call } from "./call.ts";
import { ensureCert, localAddresses, multiplex } from "./tls.ts";
import { CENTRAL, CENTRAL_ID, CENTRAL_NAME } from "./identity.ts";
import { loadProjects, loadSaved, type ProjectConfig } from "./projects.ts";
import { MoonshineSTT } from "./stt.ts";
import type { Mode, Rewriter } from "./types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const webDir = join(root, "web");
const workDir = resolve(process.env.BUDDY_CWD ?? join(root, "session"));
const callsDir = resolve(process.env.BUDDY_CALLS_DIR ?? join(root, "calls"));
// the central agent's home: new projects are made here, and the roster is remembered here
const homeDir = resolve((process.env.BUDDY_HOME ?? "~/buddy-home").replace(/^~(?=$|\/)/, homedir()));
const rosterFile = join(homeDir, ".buddy", "roster.json");
const PORT = Number(process.env.PORT ?? 3000);
// localhost only unless you say otherwise: reaching Buddy is as good as a shell on this machine
const HOST = process.env.BUDDY_HOST ?? "127.0.0.1";
const onLan = HOST === "0.0.0.0" || HOST === "::";
// TLS is required away from localhost, because the microphone needs a secure context
const useTls = process.env.BUDDY_TLS === "1" || (onLan && process.env.BUDDY_TLS !== "0");
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

const systemPrompt = ["VOICE.md", "examples.md", "condensation.md"]
  .map((f) => readFileSync(join(root, "skill", "claude-call", f), "utf8"))
  .join("\n\n");

const centralPrompt = readFileSync(join(root, "skill", "claude-call", "CENTRAL.md"), "utf8")
  .replaceAll("{{NAME}}", CENTRAL_NAME)
  .replaceAll("{{HOME}}", homeDir);

const rewriter: Rewriter = { toSpeech: async (x) => x };

/**
 * The roster for a call: configured projects, then the ones opened in earlier calls. Read fresh
 * for each call, so a project made in one call is there in the next. A remembered folder that
 * has since been deleted is dropped rather than quietly made again.
 */
async function roster(): Promise<ProjectConfig[]> {
  const saved = [];
  for (const s of await loadSaved(rosterFile)) {
    if (await stat(s.dir).then((x) => x.isDirectory(), () => false)) saved.push(s);
  }
  const list = await loadProjects(root, workDir, saved);
  // a configured project's directory must exist before Claude can be spawned in it
  await Promise.all(list.map((p) => mkdir(p.dir, { recursive: true })));
  return list;
}

await mkdir(homeDir, { recursive: true });
const projects = await roster();

let sttState: "loading" | "ready" | "error" = "loading";
const stt = new MoonshineSTT();
const sockets = new Set<WebSocket>();
stt.ready().then(
  () => { sttState = "ready"; console.log("Speech recognition ready"); },
  (e) => { sttState = "error"; console.error("Speech recognition failed to load:", e); },
).finally(() => { for (const ws of sockets) ws.send(JSON.stringify({ type: "stt", state: sttState })); });

const auth = new Auth();
const tls = useTls ? await ensureCert(join(root, "certs")) : null;

const handler = async (req: any, res: any) => {
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
};

const secure = tls ? createHttpsServer({ key: tls.key, cert: tls.cert }, handler) : null;
const http = secure ?? createHttpServer(handler);

/** Over TLS, a plain http request to the same port is answered with a redirect, not a dead socket. */
const redirector = secure
  ? createHttpServer((req, res) => {
      const host = String(req.headers.host ?? `localhost:${PORT}`);
      res.writeHead(308, { location: `https://${host}${req.url ?? "/"}`, "cache-control": "no-store" }).end("Buddy is served over https.");
    })
  : null;
const front = secure && redirector ? multiplex(secure, redirector) : http;

/**
 * The access code travels as a WebSocket subprotocol rather than in the URL, so it never lands
 * in browser history or a proxy log. Nothing behind this handshake is reachable without it.
 */
const wss = new WebSocketServer({
  server: http,
  handleProtocols: (protocols: Set<string>) => {
    for (const p of protocols) if (p.startsWith("buddy.")) return p;
    return false;
  },
  verifyClient: ({ req }: { req: any }, done: (ok: boolean, code?: number, msg?: string) => void) => {
    const from = req.socket?.remoteAddress ?? "unknown";
    if (auth.blocked(from)) {
      console.warn(`Refusing ${from} for another ${auth.waitSeconds(from)}s: too many wrong codes`);
      return done(false, 429, "too many attempts");
    }
    const offered = String(req.headers["sec-websocket-protocol"] ?? "")
      .split(",").map((x: string) => x.trim()).find((x: string) => x.startsWith("buddy."));
    if (auth.check(offered?.slice("buddy.".length))) {
      auth.passed(from);
      return done(true);
    }
    auth.failed(from);
    console.warn(`Refused a connection from ${from}: wrong or missing access code`);
    done(false, 401, "wrong access code");
  },
});

wss.on("connection", (ws: WebSocket) => {
  sockets.add(ws);
  const send = (m: Record<string, any>) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  send({ type: "stt", state: sttState });
  send({ type: "central", identity: CENTRAL, name: CENTRAL_NAME, id: CENTRAL_ID, home: homeDir });

  let mode: Mode = "visual";
  let call: Call | null = null;
  let segmentId: string | null = null;

  const endCall = () => {
    const c = call;
    call = null;
    c?.close().catch((e) => console.error(e));
  };

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
    if (m.mode === "audio" || m.mode === "visual") { mode = m.mode; call?.setMode(mode); }

    switch (m.type) {
      case "call-start":
        if (!call) {
          call = new Call({ projects: await roster(), home: homeDir, systemPrompt, centralPrompt, callsDir, rosterFile, rewriter, send });
          call.setMode(mode);
          await call.start();
        }
        break;
      case "segment":
        segmentId = String(m.id);
        break;
      case "utterance":
        if (typeof m.text === "string" && m.text.trim()) call?.ask(String(m.project ?? ""), m.text.trim(), m.context);
        break;
      case "focus":
        call?.focus(m.project ? String(m.project) : null);
        break;
      case "tell":
        if (typeof m.text === "string" && m.text.trim() && !call?.tell(String(m.project), m.text.trim())) {
          send({ type: "error", project: m.project, text: "There is no project by that name to pass that on to." });
        }
        break;
      case "interrupt":
        call?.interrupt(m.project ? String(m.project) : undefined);
        break;
      case "grant":
        if (!call?.grant(String(m.project), m.scope === "always" ? "always" : "once", m.requestId ? String(m.requestId) : undefined)) {
          send({ type: "note", project: m.project, text: "There is nothing waiting for permission there." });
        }
        break;
      case "deny":
        if (!call?.deny(String(m.project), m.requestId ? String(m.requestId) : undefined)) {
          send({ type: "note", project: m.project, text: "There is nothing waiting for permission there." });
        }
        break;
      case "create": {
        const problem = await call?.create({
          name: m.name ? String(m.name) : undefined,
          folder: m.folder ? String(m.folder) : undefined,
          path: m.path ? String(m.path) : undefined,
          brief: m.brief ? String(m.brief) : undefined,
          focus: !!m.focus,
        });
        if (problem) send({ type: "note", text: problem, problem: true });
        break;
      }
      case "park":
        call?.park(String(m.project));
        break;
      case "remove":
        call?.remove(String(m.project));
        break;
      case "call-end":
        endCall();
        break;
    }
  });

  ws.on("close", () => { sockets.delete(ws); endCall(); });
});

// Listening on every interface means dual stack: binding 0.0.0.0 alone is IPv4 only, and macOS
// resolves localhost to ::1 first, so the localhost URL would not answer.
const listenArgs: any[] = onLan ? [PORT] : [PORT, HOST];
front.listen(...listenArgs, () => {
  const scheme = tls ? "https" : "http";
  console.log(`\nBuddy is on ${scheme}://localhost:${PORT}`);
  if (onLan) for (const a of localAddresses()) console.log(`           and ${scheme}://${a}:${PORT}  ← from your phone, same network`);
  console.log(`\n  access code: ${auth.code}${auth.generated ? "  (set BUDDY_TOKEN to choose your own)" : ""}`);
  console.log("  the code is asked for once per device and is never part of the link");
  if (tls) console.log(`\n  the certificate is self-signed, so each device shows a warning once.\n  Accept it, or run: brew install mkcert && mkcert -install && mkcert localhost ${localAddresses().join(" ")}`);
  if (!onLan) console.log("\n  reachable from this machine only. BUDDY_HOST=0.0.0.0 opens it to your network.");
  console.log(`\n  ${CENTRAL_NAME}, the central agent, works in ${homeDir}`);
  if (projects.length) {
    console.log("\n  projects on the roster:");
    for (const p of projects) console.log(`  · ${p.name} → ${p.dir} (${p.permissionMode} on the line, ${p.backgroundPermissionMode} in the background)`);
  } else {
    console.log(`\n  no projects yet — ask ${CENTRAL_NAME} to start one: "start a new project for a todo app"`);
  }
  console.log("");
});

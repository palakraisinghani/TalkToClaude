import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { mkdir, readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { extname, join, normalize, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import { Auth } from "./auth.ts";
import { Call } from "./call.ts";
import { ensureCert, localAddresses, multiplex } from "./tls.ts";
import { CENTRAL, CENTRAL_NAME } from "./identity.ts";
import { loadProjects } from "./projects.ts";
import { MoonshineSTT } from "./stt.ts";
import type { Mode, Rewriter } from "./types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const webDir = join(root, "web");
const workDir = resolve(process.env.BUDDY_CWD ?? join(root, "session"));
const callsDir = resolve(process.env.BUDDY_CALLS_DIR ?? join(root, "calls"));
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

const rewriter: Rewriter = { toSpeech: async (x) => x };

// Last resort: something unexpected should be reported, never silently kill every call that
// happens to be running. Anything that reaches here is a bug to fix, not a reason to go down.
process.on("uncaughtException", (err) => console.error("Unhandled error (server kept running):", err));
process.on("unhandledRejection", (err) => console.error("Unhandled rejection (server kept running):", err));

const projects = await loadProjects(root, workDir);
// a project's directory must exist before Claude can be spawned in it
await Promise.all(projects.map((p) => mkdir(p.dir, { recursive: true })));

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
/** Every call currently running, so shutting down can close their Claude processes. */
const calls = new Set<Call>();

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
  send({ type: "central", identity: CENTRAL, name: CENTRAL_NAME });

  let mode: Mode = "visual";
  let call: Call | null = null;
  let segmentId: string | null = null;

  const endCall = () => {
    const c = call;
    call = null;
    if (!c) return;
    calls.delete(c);
    c.close().catch((e) => console.error(e));
  };

  ws.on("message", async (raw, isBinary) => {
    if (isBinary) {
      const id = segmentId;
      segmentId = null;
      if (!id) return;
      try {
        const buf = raw as Buffer;
        // `ws` can hand back a Buffer that is a view into a pooled ArrayBuffer at an odd
        // byteOffset, and Int16Array refuses any offset that is not a multiple of 2. Reading
        // each sample through the Buffer API instead works at any offset or alignment, so a
        // pooling detail on the wire can never take the whole server down with it.
        const n = Math.floor(buf.byteLength / 2);
        const audio = new Float32Array(n);
        for (let i = 0; i < n; i++) audio[i] = buf.readInt16LE(i * 2) / 32768;
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
          call = new Call({ projects, systemPrompt, callsDir, rewriter, send, appRoot: root });
          calls.add(call);
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
      case "interrupt":
        call?.interrupt(m.project ? String(m.project) : undefined);
        break;
      case "grant":
        if (!call?.grant(String(m.project), m.scope === "always" ? "always" : "once")) {
          send({ type: "error", project: m.project, text: "There is nothing waiting for permission there." });
        }
        break;
      case "park":
        call?.park(String(m.project));
        break;
      case "open":
        await call?.open(String(m.text ?? ""), { create: !!m.create, resume: m.resume, name: m.name });
        break;
      case "answer":
        await call?.answer(m.choice === "resume" ? "resume" : "new", m.session ? String(m.session) : undefined);
        break;
      case "call-end":
        endCall();
        break;
    }
  });

  ws.on("close", () => { sockets.delete(ws); endCall(); });
});

/**
 * Ctrl+C has to take the Claude processes with it.
 *
 * Each call holds one `claude` process per project. If node simply dies they are reparented and
 * keep running, with nobody attached, no port to find them on and no obvious way to stop them —
 * which is how a call ends up alive for hours after everyone has walked away.
 */
let shuttingDown = false;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal as NodeJS.Signals, () => {
    if (shuttingDown) process.exit(1); // a second Ctrl+C stops waiting and goes
    shuttingDown = true;
    process.stderr.write(`\nStopping Buddy: closing ${calls.size} call${calls.size === 1 ? "" : "s"}…\n`);
    const closed = Promise.all([...calls].map((c) => c.close().catch(() => {})));
    front.close();
    for (const ws of sockets) { try { ws.close(1001, "server stopping"); } catch { /* already gone */ } }
    const bail = setTimeout(() => { process.stderr.write("Gave up waiting; exiting.\n"); process.exit(0); }, 5000);
    closed.then(() => {
      clearTimeout(bail);
      process.stderr.write("Stopped.\n");
      process.exit(0);
    });
  });
}

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
  if (projects.length) {
    console.log("\n  projects open at startup:");
    for (const p of projects) console.log(`  · ${p.name} → ${p.dir} (${p.permissionMode} on the line, ${p.backgroundPermissionMode} in the background)`);
  } else {
    console.log(`\n  no projects yet — ask ${CENTRAL_NAME} to open one: "${CENTRAL_NAME}, open <folder>"`);
  }
  console.log("");
});

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
import { Notebook } from "./notebook.ts";
import { claudeStatus, forgetKey, loadSavedKey, openSignIn, saveKey } from "./claude.ts";
import { ensureCert, localAddresses, multiplex } from "./tls.ts";
import { CENTRAL, CENTRAL_ID, centralName, setCentralName } from "./identity.ts";
import { loadCentral, loadProjects, loadSaved, saveRoster, type ProjectConfig } from "./projects.ts";
import { durationMs, features, MAX_NAME_MS, MAX_SEARCH_MS, MAX_TRIES, SURE, Voiceprints, type TeachAssessment } from "./voiceprint.ts";
import { forAgent, Refiner } from "./refine.ts";
import { confusable } from "../web/route.js";
import { makeSTT, RECOGNISERS } from "./stt.ts";
import { readFile as readText, writeFile as writeText } from "node:fs/promises";
import { pickFolder } from "./picker.ts";
import { canSpeak, synthesize } from "./tts.ts";
import { testName } from "./namecheck.ts";
import { Media } from "./media.ts";
import type { Mode, Rewriter } from "./types.ts";

const root = fileURLToPath(new URL("..", import.meta.url));
const webDir = join(root, "web");
// what ClaudeCall writes as it runs; the packaged app keeps it out of the app itself
const dataDir = resolve(process.env.BUDDY_DATA ?? root);
const workDir = resolve(process.env.BUDDY_CWD ?? join(dataDir, "session"));
const callsDir = resolve(process.env.BUDDY_CALLS_DIR ?? join(dataDir, "calls"));
// the central agent's home: new projects are made here, and the roster is remembered here
const homeDir = resolve((process.env.BUDDY_HOME ?? "~/buddy-home").replace(/^~(?=$|\/)/, homedir()));
const rosterFile = join(homeDir, ".buddy", "roster.json");
// what Ada keeps from one call to the next: one notebook for the app, shared by every call
const notebook = new Notebook(join(homeDir, ".buddy", "ada-notebook.json"));
const PORT = Number(process.env.PORT ?? 3000);
// localhost only unless you say otherwise: reaching Buddy is as good as a shell on this machine
const HOST = process.env.BUDDY_HOST ?? "127.0.0.1";
const onLan = HOST === "0.0.0.0" || HOST === "::";
// TLS is required away from localhost, because the microphone needs a secure context
const useTls = process.env.BUDDY_TLS === "1" || (onLan && process.env.BUDDY_TLS !== "0");
const TYPES: Record<string, string> = {
  ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css",
  ".wasm": "application/wasm", ".svg": "image/svg+xml", ".onnx": "application/octet-stream",
  ".png": "image/png", ".webmanifest": "application/manifest+json", ".json": "application/json",
};
// browser-side voice activity detection, served from node_modules so the page needs no CDN
const STATIC: [string, string][] = [
  ["/vendor/vad/", join(root, "node_modules", "@ricky0123", "vad-web", "dist")],
  ["/vendor/ort/", join(root, "node_modules", "onnxruntime-web", "dist")],
  // diagrams on the canvas, drawn in the page; loaded only when the first one appears
  ["/vendor/mermaid/", join(root, "node_modules", "mermaid", "dist")],
  ["/", webDir],
];

const systemPrompt = ["VOICE.md", "examples.md", "condensation.md"]
  .map((f) => readFileSync(join(root, "skill", "claude-call", f), "utf8"))
  .join("\n\n");

// {{NAME}} is filled in when her session starts, so a rename is picked up
const centralPrompt = readFileSync(join(root, "skill", "claude-call", "CENTRAL.md"), "utf8")
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
// an API key typed into ClaudeCall earlier, for the agents (see claude.ts)
await loadSavedKey();
// a name the lead gave her on an earlier call, before the team is named around it
const savedName = (await loadCentral(rosterFile)).name;
if (savedName) setCentralName(savedName);
const projects = await roster();

/**
 * How the lead speaks, and which recogniser to hear them with, kept beside the roster. The accent
 * goes to the clean-up pass, which then expects that accent's usual mishearings; the recogniser
 * can be the quicker one or the more accurate one (see stt.ts for what each gets right).
 */
interface Hearing { accent: string; recogniser: string }
const hearingFile = join(homeDir, ".buddy", "hearing.json");
let hearing: Hearing = { accent: "", recogniser: process.env.BUDDY_STT_MODEL ?? "fast", ...(await readText(hearingFile, "utf8").then((t) => JSON.parse(t), () => ({}))) };
const hearingView = () => ({ type: "hearing", ...hearing, recognisers: Object.keys(RECOGNISERS) });

let sttState: "loading" | "ready" | "error" = "loading";
const sockets = new Set<WebSocket>();
const broadcast = (m: Record<string, any>) => { for (const ws of sockets) ws.readyState === ws.OPEN && ws.send(JSON.stringify(m)); };
let stt = makeSTT(hearing.recogniser);
/** Load a recogniser and say so on every page; the old one keeps hearing until the new one is ready. */
function useRecogniser(which: string) {
  const next = makeSTT(which);
  sttState = "loading";
  broadcast({ type: "stt", state: sttState, recogniser: which });
  next.ready().then(
    () => { stt = next; sttState = "ready"; console.log(`Speech recognition ready (${which})`); },
    (e) => { sttState = "error"; console.error(`Speech recognition (${which}) failed to load:`, e); },
  ).finally(() => broadcast({ type: "stt", state: sttState, recogniser: which }));
}
useRecogniser(hearing.recogniser);

/** Answers picked on a question card, as question text to chosen label; anything else is dropped. */
const answersOf = (a: unknown): Record<string, string> | undefined =>
  a && typeof a === "object" ? Object.fromEntries(Object.entries(a).map(([q, v]) => [String(q).slice(0, 1000), String(v).slice(0, 1000)])) : undefined;

/**
 * Has ClaudeCall's own code changed since this server started? The page reloads new code on its
 * own, but the server keeps running what it started with, so features half-work until a restart.
 */
const STARTED = Date.now();
async function changedSinceStart(): Promise<string[]> {
  const { readdir } = await import("node:fs/promises");
  const out: string[] = [];
  for (const dir of ["server", "skill/claude-call"]) {
    for (const f of await readdir(join(root, dir)).catch(() => [] as string[])) {
      if (/\.test\./.test(f) || !/\.(ts|md)$/.test(f)) continue;
      const s = await stat(join(root, dir, f)).catch(() => null);
      if (s && s.mtimeMs > STARTED) out.push(`${dir}/${f}`);
    }
  }
  return out;
}

const auth = new Auth();
// pictures and videos for the canvas, from agents' folders or the web, kept for the server's life
const media = new Media(undefined, { cacheDir: join(homeDir, ".buddy", "media-cache"), secretFile: join(homeDir, ".buddy", "media-secret") });
await media.init();
// the clean-up pass between speech recognition and the agents, warmed when a call starts
const refiner = new Refiner();
// how the lead's own voice sounds saying each agent's name, taught on the page
const voices = new Voiceprints(join(homeDir, ".buddy", "voices"));
await voices.load();

/**
 * Rename the assistant with no call running: her card is on the page before a call starts, and
 * a rename there must not be lost. The new name is kept with the roster for the next call.
 */
async function renameOffline(id: string, name: string): Promise<string | null> {
  if (id !== CENTRAL_ID) return "Start the call to rename an agent.";
  const clean = name.trim();
  if (!/^[A-Za-z][A-Za-z']{1,19}$/.test(clean)) return `"${clean}" will not work as a name: use one word, letters only, easy to say.`;
  const saved = await loadSaved(rosterFile);
  const clash = saved.find((p) => p.name.toLowerCase() === clean.toLowerCase())?.name ?? confusable(clean, saved.map((p) => p.name));
  if (clash) return `"${clean}" sounds too much like ${clash}, so the two would be hard to tell apart by voice. Pick another name.`;
  const named = clean[0].toUpperCase() + clean.slice(1);
  setCentralName(named);
  const central = await loadCentral(rosterFile);
  await saveRoster(rosterFile, saved, { ...central, name: named, aliases: [] });
  return null;
}
const tls = useTls ? await ensureCert(join(dataDir, "certs")) : null;

// Which build this server is. The app writes a stamp beside itself (scripts/build-mac.sh); from
// source it is the moment it started. The launcher checks it after an update to be sure the new
// server really took over, and the page reloads itself when it changes.
const build = (await readText(join(root, "..", "build"), "utf8").catch(() => "")).trim() || `dev-${Date.now().toString(36)}`;

const handler = async (req: any, res: any) => {
  try {
    const url = decodeURIComponent((req.url ?? "/").split("?")[0]);
    if (url === "/version") return void res.writeHead(200, { "content-type": "text/plain", "cache-control": "no-store" }).end(build);
    // a media link the page was given over the socket; the token is the only way in
    if (url.startsWith("/media/") && (await media.serve(req, res, url.slice("/media/".length)))) return;
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
      res.writeHead(308, { location: `https://${host}${req.url ?? "/"}`, "cache-control": "no-store" }).end("ClaudeCall is served over https.");
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

/**
 * A call the lead hung up on while the team was still at work. It keeps running with nobody on it,
 * and what happens meanwhile is kept, so the lead can rejoin and be told. Ended once the team has
 * been idle for a while, or after a few hours regardless.
 */
let away: { call: Call; since: number; news: Record<string, any>[]; timer: ReturnType<typeof setInterval> } | null = null;
const AWAY_MAX_MS = 3 * 60 * 60_000;
const AWAY_IDLE_MS = 20 * 60_000;
function leaveRunning(c: Call) {
  away?.call.close().catch(() => {});
  if (away) clearInterval(away.timer);
  const keep: Record<string, any>[] = [];
  let idleSince = 0;
  const timer = setInterval(() => {
    if (!away || away.call !== c) return clearInterval(timer);
    const idle = !c.busy();
    idleSince = idle ? idleSince || Date.now() : 0;
    if (Date.now() - away.since > AWAY_MAX_MS || (idleSince && Date.now() - idleSince > AWAY_IDLE_MS)) {
      console.log("The team has gone quiet; ending the call that was left running.");
      clearInterval(timer);
      away = null;
      c.close().catch((e) => console.error(e));
    }
  }, 30_000);
  // only what the lead would want to hear about later is kept: news, and the latest roster
  c.setSend((m) => { if (m.type === "notify") keep.push(m); });
  // nobody is on the line any more: every agent now works in the background, so what the one the
  // lead was talking to finishes is kept as news too
  c.focus(null);
  away = { call: c, since: Date.now(), news: keep, timer };
  console.log("Hung up with the team still at work: they carry on, and the lead is briefed on return.");
}

wss.on("connection", (ws: WebSocket, req: any) => {
  // A page on this machine loads an original picture in milliseconds, so it never waits for the
  // light copy; a phone over the network may wait a moment for it, since there bytes cost time.
  const addr = String(req?.socket?.remoteAddress ?? "");
  // behind a proxy on this machine (tailscale serve, a reverse proxy) the page is still far away
  const proxied = !!req?.headers?.["x-forwarded-for"];
  const sameComputer = /^(::1|127\.|::ffff:127\.)/.test(addr) && !proxied;
  const pictureWait = sameComputer ? 0 : 1500;
  sockets.add(ws);
  const send = (m: Record<string, any>) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(m));
  send({ type: "hello", build });
  send({ type: "stt", state: sttState, recogniser: hearing.recogniser });
  send(hearingView());
  // the page can place each voice in space when this machine can make speech as audio
  send({ type: "tts-capable", ok: canSpeak });
  send({ type: "central", identity: CENTRAL, name: centralName(), id: CENTRAL_ID, home: homeDir });
  // how a phone or tablet reaches this computer, for Settings: on the network, or not at all
  send({ type: "reach", lan: onLan ? localAddresses().map((a) => `${tls ? "https" : "http"}://${a}:${PORT}`) : [] });
  changedSinceStart().then((files) => files.length && send({ type: "stale", files }), () => {});
  send({ type: "voices", counts: voices.counts(), confident: voices.confident(), relearn: voices.needsRelearning() });
  // is Claude Code installed and signed in? the page shows what is missing, if anything
  const sendClaude = () => claudeStatus().then((s) => send({ type: "claude-status", ...s, sameComputer }), () => {});
  sendClaude();

  /**
   * What the call sends, with any picture from a tool's output (an agent opening an image) turned
   * into a light cached copy and a link, rather than megabytes of text down the socket.
   */
  // One queue for everything out, so a message carrying a picture (which takes a moment to
  // prepare) can never arrive after the messages that followed it, like its turn's "done".
  let outbox: Promise<unknown> = Promise.resolve();
  const sendOut = (m: Record<string, any>) => {
    outbox = outbox.then(() => {
      if (m.type !== "tool_result" || !m.images?.length) return send(m);
      return Promise.all(m.images.map((d: string) => media.fromData(d, pictureWait).catch(() => ({ error: "unreadable" }))))
        .then((rs) => send({ ...m, images: rs.filter((r: any) => !r.error) }));
    }).catch((e) => console.error(e));
  };
  let mode: Mode = "visual";
  let call: Call | null = null;
  /** A call being set up: a second call-start meanwhile must not make a second call. */
  let starting: Promise<void> | null = null;
  /** The agent whose name the lead is teaching, and the sound of each try so far. */
  let teaching: string | null = null;
  let teachTries: number[][][] = [];
  let teachAttempts = 0;
  let teachLast: TeachAssessment | null = null;
  /** How many tries the recogniser wrote the name itself for: part of how sure teaching is. */
  let teachHeardName = 0;
  let segmentId: string | null = null;

  const endCall = () => {
    const c = call;
    call = null;
    if (!c) return;
    // hanging up while the team is still busy leaves them working; otherwise the call ends
    if (c.busy()) leaveRunning(c);
    else c.close().catch((e) => console.error(e));
  };

  // Every message is handled inside a guard: one bad request (a folder that cannot be made, an
  // unreadable file) is reported on the page, and never takes the whole server down.
  ws.on("message", (raw, isBinary) => {
    handle(raw as Buffer, isBinary).catch((e) => {
      console.error(e);
      send({ type: "note", text: `That did not work: ${(e as Error).message}`, problem: true });
    });
  });

  const handle = async (raw: Buffer, isBinary: boolean) => {
    if (isBinary) {
      const id = segmentId;
      segmentId = null;
      if (!id) return;
      let buf = raw as Buffer;
      // ws may hand us a slice of a pooled buffer at an odd offset; Int16Array needs 2-byte alignment
      if (buf.byteOffset % 2) buf = Buffer.from(buf);
      const pcm = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
      const audio = Float32Array.from(pcm, (x) => x / 32768);
      try {
        const t = Date.now();
        // the names on the call go in as a prompt, so the recogniser reads them right
        const names = call ? call.roster.map((p: any) => p.name) : [centralName()];
        const text = await stt.transcribe(audio, { names });
        // Anything short enough might hold a name: "Juno", "hey Juno", "Juno, run the tests". Its
        // sound is searched for the voices the lead taught. A teaching try must be just the name.
        const ms = durationMs(audio);
        const feats = ms <= (teaching ? MAX_NAME_MS : MAX_SEARCH_MS) ? features(audio) : null;
        if (teaching) {
          // a try at the name being taught: judged at once, and dropped if it does not fit
          teachAttempts++;
          // did the recogniser (Whisper, prompted with the names) write the name for this try?
          const who = call?.roster.find((p: any) => p.id === teaching);
          const spellings = [who?.name, ...(who?.aliases ?? [])].filter(Boolean).map((x: string) => x.toLowerCase());
          if (spellings.some((sp) => new RegExp(`\\b${sp.replace(/[^a-z']/g, "")}\\b`, "i").test(text))) teachHeardName++;
          let a: TeachAssessment;
          if (feats) {
            teachTries.push(feats);
            a = voices.assess(teaching, teachTries, { recognised: teachHeardName / teachAttempts });
            // keep exactly the tries it kept: an earlier one can turn out to be the odd one out
            teachTries = a.keep.map((i) => teachTries[i]);
          } else a = { ...(teachLast ?? voices.assess(teaching, teachTries)), outlier: true };
          teachLast = a;
          send({ type: "transcript", id, text, ms: Date.now() - t, sample: true });
          // it keeps listening past "learned", so the lead sees it grow surer, until it is sure
          send({ type: "teach-progress", project: teaching, attempt: teachAttempts, ...a, heardName: teachHeardName, tooLong: !feats || undefined, done: a.confidence >= SURE || teachAttempts >= MAX_TRIES });
          return;
        }
        const match = feats ? voices.match(feats, call ? call.roster.map((p: any) => p.id) : undefined) : null;
        send({ type: "transcript", id, text, ms: Date.now() - t, ...(match ? { match: { project: match.id, distance: +match.distance.toFixed(2), strength: match.strength, startMs: match.startMs } } : {}) });
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
        if (call || starting) break;
        // a call left running while the lead was away: rejoin it, and say what happened
        if (away) {
          const back = away;
          away = null;
          clearInterval(back.timer);
          call = back.call;
          call.setSend(sendOut);
          call.setMode(mode);
          send({ type: "briefing", since: back.since, news: back.news });
          for (const n of back.news) sendOut(n);
          call.republish();
          break;
        }
        starting = (async () => {
          const saved = await loadCentral(rosterFile);
          const list = await roster();
          // hung up while it was getting ready: make nothing, so nothing is left running
          if (ws.readyState !== ws.OPEN) return;
          const c = new Call({ projects: list, home: homeDir, systemPrompt, centralPrompt, callsDir, rosterFile, rewriter, send: sendOut, centralModel: saved.model, centralAliases: saved.aliases, centralSound: saved.sound, centralMode: saved.permissionMode, centralEffort: saved.effort, notebook });
          call = c;
          c.setMode(mode);
          refiner.warm();
          await c.start();
        })().finally(() => { starting = null; });
        await starting;
        break;
      case "segment":
        segmentId = String(m.id);
        break;
      case "utterance": {
        if (typeof m.text !== "string" || !m.text.trim() || !call) break;
        const to = String(m.project ?? "");
        const heard = m.text.trim();
        call.setCanvas(m.canvas);
        // spoken words get a clean-up pass first, unless typed or switched off on the page
        if (m.typed || m.refine === false) { call.ask(to, heard, m.context); break; }
        const c = call;
        const r = await refiner.refine(heard, { ...c.hearingContext(to), ...(hearing.accent ? { accent: hearing.accent } : {}) });
        if (call !== c) break; // the call ended while the words were being cleaned up
        send({ type: "refined", project: to, raw: heard, text: r.text, changed: r.changed, ms: r.ms, skipped: r.skipped });
        c.ask(to, forAgent(heard, r), m.context);
        break;
      }
      case "focus":
        call?.focus(m.project ? String(m.project) : null);
        break;
      case "btw":
        if (typeof m.text === "string" && m.text.trim()) call?.btw(String(m.project ?? ""), m.text.trim(), m.context ?? null).catch((e) => console.error(e));
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
        if (!call?.grant(String(m.project), m.scope === "always" ? "always" : "once", m.requestId ? String(m.requestId) : undefined, answersOf(m.answers))) {
          send({ type: "note", project: m.project, text: "There is nothing waiting for permission there." });
        }
        break;
      case "deny":
        if (!call?.deny(String(m.project), m.requestId ? String(m.requestId) : undefined, typeof m.message === "string" ? m.message.slice(0, 4000) : "")) {
          send({ type: "note", project: m.project, text: "There is nothing waiting for permission there." });
        }
        break;
      case "media": {
        // a picture, GIF or video named in an agent's markdown: a file in its folder, or a web link
        const src = typeof m.src === "string" ? m.src.trim() : "";
        if (!src) break;
        const dir = call?.dirOf(String(m.project)) ?? homeDir;
        (/^https?:\/\//i.test(src) ? media.remote(src, pictureWait, { proxy: !!m.proxy }) : media.local(dir, src, pictureWait)).then(
          (r) => send({ type: "media", project: m.project, src: m.src, ...r }),
          (e) => send({ type: "media", project: m.project, src: m.src, error: (e as Error).message }),
        );
        break;
      }
      case "control": {
        // a mode, effort, new conversation or compact, from a button, a typed /command or the voice
        const r = call?.control(String(m.project), String(m.what ?? ""), String(m.value ?? ""));
        send({ type: "control-done", project: m.project, ok: !!r?.ok, said: r?.said ?? "There is no call." });
        break;
      }
      case "claude-check":
        sendClaude();
        break;
      case "claude-login":
        // Claude Code's own sign-in, in a terminal on this computer: only from this computer,
        // where the lead can see the terminal and the browser it opens
        if (!sameComputer) { send({ type: "claude-login", error: "Sign in on the computer running ClaudeCall: open a terminal there and run: claude auth login" }); break; }
        openSignIn(m.kind === "console" ? "console" : "claudeai").then(
          () => send({ type: "claude-login", ok: true }),
          (e) => send({ type: "claude-login", error: (e as Error).message }),
        );
        break;
      case "claude-key": {
        const problem = await saveKey(String(m.key ?? ""));
        if (problem) send({ type: "claude-login", error: problem });
        else sendClaude();
        break;
      }
      case "claude-forget-key":
        await forgetKey();
        sendClaude();
        break;
      case "pick-folder":
        // opens the system's own folder chooser on this machine, and answers with the path
        pickFolder(homedir()).then(
          (path) => send({ type: "picked", path }),
          (e) => send({ type: "picked", path: null, error: (e as Error).message }),
        );
        break;
      case "create": {
        const problem = await call?.create({
          name: m.name ? String(m.name) : undefined,
          folder: m.folder ? String(m.folder) : undefined,
          path: m.path ? String(m.path) : undefined,
          brief: m.brief ? String(m.brief) : undefined,
          prompt: m.prompt ? String(m.prompt).slice(0, 8000) : undefined,
          model: m.model ? String(m.model).slice(0, 64) : undefined,
          focus: !!m.focus,
        });
        if (problem) send({ type: "note", text: problem, problem: true });
        break;
      }
      case "handoff":
        // "connect me to Ada and ask her to switch me to Juno", heard by the page
        if (m.to) {
          const problem = call?.handoff(String(m.from ?? ""), String(m.to), String(m.text ?? "").slice(0, 2000), { byLead: true });
          if (problem) send({ type: "note", text: problem, problem: true });
        }
        break;
      case "media-rescue": {
        // a picture pasted as text and cut off: show the file the agent was working with instead
        const file = await call?.rescueImage(String(m.project));
        const r = file ? await media.local("/", file, pictureWait) : { error: "the picture was pasted in as text and cut off, and no picture file turned up in that agent's recent work" };
        send({ type: "media", project: m.project, src: m.src, ...r, ...(file ? { rescued: file } : {}) });
        break;
      }
      case "teach-start":
        // from now until teach-end, short clips are samples of how the lead says this name
        teaching = String(m.project ?? "") || null;
        teachTries = [];
        teachAttempts = 0;
        teachHeardName = 0;
        teachLast = null;
        break;
      case "teach-end": {
        const id = teaching;
        teaching = null;
        if (id && m.save && teachTries.length) {
          const count = await voices.add(id, teachTries, !!teachLast?.confident);
          send({ type: "voiceprint", project: id, count, added: teachTries.length });
          send({ type: "voices", counts: voices.counts(), confident: voices.confident(), relearn: voices.needsRelearning() });
        }
        teachTries = [];
        break;
      }
      case "teach": {
        // how the lead says a name, from a few tries; kept as that agent's aliases
        const heard = Array.isArray(m.heard) ? m.heard.map((h: unknown) => String(h).slice(0, 40)).slice(0, 10) : [];
        const kept = call?.teach(String(m.project), heard) ?? [];
        send({ type: "taught", project: m.project, kept });
        break;
      }
      case "rename": {
        const problem = call ? call.rename(String(m.project), String(m.name ?? "")) : await renameOffline(String(m.project), String(m.name ?? ""));
        if (!problem) {
          // the old name's sound no longer applies; the page goes on to teach the new one
          await voices.clear(String(m.project));
          send({ type: "voices", counts: voices.counts(), confident: voices.confident(), relearn: voices.needsRelearning() });
          if (!call && String(m.project) === CENTRAL_ID) send({ type: "central", identity: CENTRAL, name: centralName(), id: CENTRAL_ID, home: homeDir });
        }
        // a new name is followed on the page by learning how the lead says it
        send(problem ? { type: "note", project: m.project, text: problem, problem: true } : { type: "renamed", project: m.project, name: String(m.name).trim() });
        break;
      }
      case "hearing": {
        // the lead's accent, and which recogniser to use: saved, and applied straight away
        const accent = typeof m.accent === "string" ? m.accent.slice(0, 60) : hearing.accent;
        const recogniser = typeof m.recogniser === "string" && m.recogniser in RECOGNISERS ? m.recogniser : hearing.recogniser;
        const changed = recogniser !== hearing.recogniser;
        hearing = { accent, recogniser };
        await mkdir(join(homeDir, ".buddy"), { recursive: true });
        await writeText(hearingFile, JSON.stringify(hearing, null, 2) + "\n");
        if (changed) useRecogniser(recogniser);
        broadcast(hearingView());
        break;
      }
      case "undo": {
        // undoing an agent's last turn: first what it would change, then, once confirmed, doing it
        const id = String(m.project ?? "");
        if (m.dry) {
          const preview = await call?.undoPreview(id);
          send({ type: "undo-preview", project: id, files: preview?.files ?? null, label: preview?.label ?? "" });
        } else {
          const files = await call?.undo(id);
          if (files == null) send({ type: "note", project: id, text: "There is nothing to undo there.", problem: true });
        }
        break;
      }
      case "name-test": {
        // how well a name comes through, said in several voices with real-world drift (namecheck.ts)
        const name = String(m.name ?? "").trim().slice(0, 40);
        if (!name || !canSpeak) { send({ type: "name-test", name, error: canSpeak ? "no name" : "unavailable" }); break; }
        const others = Array.isArray(m.others) ? m.others.map(String).slice(0, 20) : [];
        testName(name, others, stt, hearing.accent).then(
          (r) => send({ type: "name-test", name, ...r }),
          (e) => send({ type: "name-test", name, error: (e as Error).message }),
        );
        break;
      }
      case "tts": {
        // one sentence as audio in an agent's own system voice, for the page to play panned
        if (!canSpeak || typeof m.text !== "string") { send({ type: "tts", id: m.id, error: "unavailable" }); break; }
        const voices = Array.isArray(m.voices) ? m.voices.map(String).slice(0, 6) : [];
        synthesize(m.text, voices, Number(m.rate) || 1).then(
          (wav) => send({ type: "tts", id: m.id, wav: wav.toString("base64") }),
          (e) => send({ type: "tts", id: m.id, error: (e as Error).message }),
        );
        break;
      }
      case "set-sound":
        // an agent's voice, speed, pitch, volume or side, from the settings
        if (!call?.setSound(String(m.project), { voice: m.voice, rate: m.rate, pitch: m.pitch, volume: m.volume, pan: m.pan })) send({ type: "note", text: "That agent's voice could not be changed.", problem: true });
        break;
      case "set-model":
        if (!call?.setModel(String(m.project), String(m.model ?? ""))) send({ type: "note", text: "There is no agent by that name to change.", problem: true });
        break;
      case "park":
        call?.park(String(m.project));
        break;
      case "remove":
        call?.remove(String(m.project));
        voices.clear(String(m.project)).catch(() => {});
        break;
      case "call-end":
        endCall();
        break;
    }
  };

  ws.on("close", () => { sockets.delete(ws); endCall(); });
});

// Listening on every interface means dual stack: binding 0.0.0.0 alone is IPv4 only, and macOS
// resolves localhost to ::1 first, so the localhost URL would not answer.
const listenArgs: any[] = onLan ? [PORT] : [PORT, HOST];
front.listen(...listenArgs, () => {
  const scheme = tls ? "https" : "http";
  console.log(`\nClaudeCall is on ${scheme}://localhost:${PORT}`);
  if (onLan) for (const a of localAddresses()) console.log(`           and ${scheme}://${a}:${PORT}  ← from your phone, same network`);
  console.log(`\n  access code: ${auth.code}${auth.generated ? "  (set BUDDY_TOKEN to choose your own)" : ""}`);
  console.log("  the code is asked for once per device and is never part of the link");
  if (tls) console.log(`\n  the certificate is self-signed, so each device shows a warning once.\n  Accept it, or run: brew install mkcert && mkcert -install && mkcert localhost ${localAddresses().join(" ")}`);
  if (!onLan) console.log("\n  reachable from this machine only. BUDDY_HOST=0.0.0.0 opens it to your network.");
  console.log(`\n  ${centralName()}, the central agent, works in ${homeDir}`);
  if (projects.length) {
    console.log("\n  projects on the roster:");
    for (const p of projects) console.log(`  · ${p.name} → ${p.dir} (${p.permissionMode} on the line, ${p.backgroundPermissionMode} in the background)`);
  } else {
    console.log(`\n  no projects yet — ask ${centralName()} to start one: "start a new project for a todo app"`);
  }
  console.log("");
});

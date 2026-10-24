import { Voice } from "./voice.js";
import { Earcons } from "./earcon.js";
import { Central } from "./central.js";
import { createVadListener, createChromeListener } from "./listen.js";
import { esc, renderMarkdown } from "./markdown.js";
import { route, LOCAL } from "./route.js";
import { isNoise } from "./noise.js";

const $ = (id) => document.getElementById(id);
const callEl = $("call"), orb = $("orb"), feed = $("feed");

// ---------- state ----------
let ws = null;
let onCall = false, muted = false;
let listener = null;
// Every agent on the call, as the server reports it: the central agent first, then the projects.
let projects = [];
let focusedId = null;
let centralId = "ada", centralName = "Ada", centralIdentity = null, homeDir = "";
let currentTurn = 0; // the latest turn of the agent on the line
// Turns of the agent on the line whose speech is played. Usually just the latest; but something
// said while it was working is queued behind the work, and the work's own report still plays.
let liveTurns = new Set();
let working = false; // the agent on the line is busy on currentTurn
let userPaused = false, pausedAt = 0;
let ducked = false; // voice held because the user started talking
let hearing = false;
let callStart = 0, lastActivity = 0, sleepTimer = null;
let segSeq = 0;
let audioCtx = null;
let greetPending = false;
let rosterSeen = false;
// Speculative sending: each utterance goes to Claude the moment it is transcribed. If you keep
// talking within MERGE_MS and Buddy has not said anything yet, that turn is quietly replaced by
// one with your whole sentence, so a mid-sentence pause never cuts you off.
const MERGE_MS = 1500;
// Saying the same thing twice this close together overrides the echo guard.
const INSIST_MS = 12_000;
// News from a background project waits until you have been quiet this long, so it never lands
// on top of you carrying on your own thought.
const RELAY_SETTLE_MS = 2500;
// Typing counts as talking: an update waits while you are mid-sentence in the text box.
const TYPING_MS = 4000;
// A finished-work notice leaves the tray this long after it has been read out.
const TOLD_LINGER_MS = 45_000;
let lastAsk = null; // { text, at, queued }
let spokeThisTurn = false;
let continuing = false;
let carry = ""; // transcript that arrived while you were already talking again; joined to what comes next
let lastTyped = 0;
let ringAfterSpeech = false;
const dropped = new Set(); // turns replaced by a merged one; their late output is ignored
const notices = []; // { uid, project, name, kind, text, detail, at, status: "waiting" | "told", el }
let noticeSeq = 0;
let relayTimer = null;
const activity = new Map(); // agent id -> { text, live }
let filter = "all";
const mode = () => ($("audioOnly").checked ? "audio" : "visual");
const project = (id) => projects.find((p) => p.id === id) ?? null;
const focused = () => project(focusedId);
const workers = () => projects.filter((p) => !p.central);
const waitingId = () => projects.find((p) => p.waiting)?.id ?? null;
const identityOf = (id) => project(id)?.identity ?? (id === centralId ? centralIdentity : null);
const nameOf = (id) => project(id)?.name ?? (id === centralId ? centralName : id ?? "");
const tilde = (p) => (p ?? "").replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");

const earcons = new Earcons(null);
const voice = new Voice({
  earcons,
  onSentence: (text, from, record) => { if (record) { spokeThisTurn = true; showBuddy(text, from, from); } render(); },
  onWord: (text, at, len) => { showBuddy(text, at, at + Math.max(len, 1)); orb.classList.add("beat"); setTimeout(() => orb.classList.remove("beat"), 110); },
  onSpeaker: (speaker) => { $("speaker").textContent = nameOf(speaker); $("capWho").textContent = nameOf(speaker); render(); },
  onIdle: () => { render(); drainNotices(); },
});
const central = new Central({ voice, identity: null });

// ---------- view ----------
function render() {
  let s;
  if (!onCall) s = "asleep";
  else if (hearing) s = "hearing";
  else if (userPaused) s = "paused";
  else if (voice.speaking) s = "speaking";
  else if (working) s = "thinking";
  else s = muted ? "muted" : "listening";
  callEl.dataset.state = s === "muted" ? "listening" : s;
  $("stateLabel").textContent = { hearing: "hearing you", speaking: "speaking", thinking: "working", listening: "listening", paused: "paused", asleep: "asleep", muted: "muted" }[s];
  document.body.classList.toggle("is-paused", userPaused);
  $("pauseBtn").textContent = userPaused ? "▶" : "⏸";
  $("pauseBtn").title = userPaused ? "Go on" : "Pause";
  $("feedState").innerHTML = working ? '<span class="spin"></span> working' : "";
  const f = focused();
  const hue = String(f?.identity?.hue ?? centralIdentity?.hue ?? 18);
  callEl.style.setProperty("--hue", hue);
  $("onLineWrap").style.setProperty("--hue", hue);
  $("onLine").textContent = f?.name ?? centralName;
  $("onLineSmall").textContent = f?.name ?? centralName;
  $("onLineAvatar").textContent = (f?.name ?? centralName)[0];
  const waiting = notices.filter((n) => n.status === "waiting").length;
  document.body.classList.toggle("has-notices", waiting > 0);
  $("nbadge").textContent = String(waiting);
  renderAgents();
  renderFilters();
}

/** What an agent is doing, in two or three words, for its card. */
function stateWords(p) {
  if (p.waiting) return "needs permission";
  if (p.question) return "has a question";
  if (p.id === focusedId) return p.state === "working" ? "on the line · working" : "on the line";
  return { working: "working", warm: "idle", cold: "not started", parked: "parked", blocked: "waiting" }[p.state] ?? p.state;
}

const cardEls = new Map(); // agent id -> element, kept so a card is updated in place, not rebuilt
function agentCard(p) {
  let el = cardEls.get(p.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "agent";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.innerHTML =
      `<span class="avatar"></span>` +
      `<span class="ainfo"><span class="arow"><span class="aname"></span><span class="arole"></span><span class="astate"></span></span>` +
      `<span class="aact"></span><span class="ameta"></span></span>` +
      `<span class="aside-btns"><span class="abadge"></span></span>`;
    if (!p.central) {
      const btns = el.querySelector(".aside-btns");
      const park = Object.assign(document.createElement("button"), { className: "aicon", textContent: "⏏", title: "Park: stop its agent, keep its conversation" });
      park.onclick = (e) => { e.stopPropagation(); send({ type: "park", project: p.id }); };
      const rm = Object.assign(document.createElement("button"), { className: "aicon", textContent: "✕", title: "Take off the roster (the folder is kept)" });
      rm.onclick = (e) => { e.stopPropagation(); if (confirm(`Take ${p.name} off the roster? Its folder and conversation stay on disk.`)) send({ type: "remove", project: p.id }); };
      btns.append(park, rm);
    }
    el.onclick = () => { if (onCall) { voice.clear(); userPaused = false; send({ type: "focus", project: p.id }); } };
    el.onkeydown = (e) => { if (e.key === "Enter") el.onclick(); };
    cardEls.set(p.id, el);
  }
  el.classList.toggle("central", !!p.central);
  el.classList.toggle("on", p.id === focusedId);
  el.dataset.state = p.waiting || p.question ? "blocked" : p.state;
  el.style.setProperty("--hue", String(p.identity?.hue ?? 0));
  el.querySelector(".avatar").textContent = p.name[0];
  el.querySelector(".aname").textContent = p.name;
  el.querySelector(".arole").textContent = p.central ? "central" : p.engagement === "delegate" ? "delegate" : "";
  el.querySelector(".astate").textContent = stateWords(p);
  const a = activity.get(p.id);
  const act = el.querySelector(".aact");
  act.textContent = a?.text || p.question || p.report || (p.central ? "Makes projects, hands out work, relays news" : "");
  act.classList.toggle("live", !!a?.live && p.state === "working");
  el.querySelector(".ameta").textContent = [tilde(p.dir), p.branch, p.turns ? `${p.turns} turn${p.turns > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  el.title = `${p.dir}${p.branch ? ` · ${p.branch}` : ""} · ${p.permissionMode}`;
  const badge = el.querySelector(".abadge");
  const count = p.central ? notices.filter((n) => n.status === "waiting").length : notices.filter((n) => n.project === p.id && (n.kind === "permission" || n.kind === "question")).length;
  badge.textContent = p.central ? String(count) : "!";
  badge.classList.toggle("show", count > 0);
  return el;
}

function place(container, els) {
  els.forEach((el, i) => { if (container.children[i] !== el) container.insertBefore(el, container.children[i] ?? null); });
  while (container.children.length > els.length) container.lastChild.remove();
}

function renderAgents() {
  const c = projects.find((p) => p.central) ?? { id: centralId, name: centralName, central: true, state: onCall ? "warm" : "cold", dir: homeDir, identity: centralIdentity ?? { hue: 18 } };
  place($("centralCard"), [agentCard(c)]);
  const list = workers();
  for (const id of cardEls.keys()) if (id !== c.id && !list.some((p) => p.id === id)) cardEls.delete(id);
  if (list.length) place($("roster"), list.map(agentCard));
  else $("roster").innerHTML = `<div class="empty">${onCall ? `No projects yet. Ask ${esc(centralName)} to start one, or to open a folder.` : "Start a call to see the roster."}</div>`;
  $("projCount").textContent = list.length ? String(list.length) : "";
}

function renderFilters() {
  const want = ["all", ...projects.map((p) => p.id)];
  const el = $("filters");
  if (el.dataset.ids !== want.join(",")) {
    el.dataset.ids = want.join(",");
    el.innerHTML = "";
    for (const id of want) {
      const b = document.createElement("button");
      b.dataset.id = id;
      if (id === "all") b.textContent = "All";
      else {
        b.style.setProperty("--hue", String(identityOf(id)?.hue ?? 0));
        b.innerHTML = `<span class="dot"></span>${esc(nameOf(id))}`;
      }
      b.onclick = () => { filter = id; applyFilter(); renderFilters(); };
      el.appendChild(b);
    }
    if (!want.includes(filter)) { filter = "all"; applyFilter(); }
  }
  for (const b of el.children) b.classList.toggle("on", b.dataset.id === filter);
}

function applyFilter(node) {
  const nodes = node ? [node] : feed.children;
  for (const n of nodes) n.style.display = filter === "all" || !n.dataset.pid || n.dataset.pid === filter ? "" : "none";
}

function showBuddy(text, a, b) {
  $("capBuddy").innerHTML = `<span class="done">${esc(text.slice(0, a))}</span><span class="now">${esc(text.slice(a, b))}</span><span class="todo">${esc(text.slice(b))}</span>`;
}
function showYou(text, pending) {
  $("capYou").innerHTML = pending ? `<span class="spin"></span> ${esc(text)}` : esc(text);
}

// ---------- behind-the-scenes feed ----------
const cards = new Map(); // key: `${project}:${turn}`
const key = (pid, turn) => `${pid}:${turn}`;
function addToFeed(el, pid) {
  if (pid) el.dataset.pid = pid;
  feed.appendChild(el);
  applyFilter(el);
}
function card(pid, turn) {
  const k = key(pid, turn);
  let c = cards.get(k);
  if (c) return c;
  const el = document.createElement("div");
  el.className = "turn";
  const hue = identityOf(pid)?.hue;
  if (hue !== undefined) el.style.setProperty("--hue", String(hue));
  el.innerHTML = `<div class="q"><span class="who">${esc(nameOf(pid) || "Buddy")}</span><span class="qt"></span><span class="st"><span class="spin"></span></span></div>`;
  if (!dropped.has(turn)) addToFeed(el, pid);
  c = { el, last: null, screen: null, screenMd: "", tools: new Map() };
  cards.set(k, c);
  return c;
}
function block(c, kind, make) {
  // consecutive output of the same kind shares a block, so the timeline reads in order
  if (c.last?.kind === kind) return c.last.node;
  const node = make();
  c.el.appendChild(node);
  c.last = { kind, node };
  return node;
}
const scrollFeed = () => { if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 160) feed.scrollTop = feed.scrollHeight; };
function feedThinking(pid, turn, text) {
  const c = card(pid, turn);
  const d = block(c, "think", () => { const d = document.createElement("details"); d.className = "think"; d.open = true; d.innerHTML = "<summary>thinking</summary><div></div>"; return d; });
  d.lastChild.textContent += text;
  d.lastChild.scrollTop = d.lastChild.scrollHeight;
  scrollFeed();
}
function feedAside(pid, turn, text) {
  if (!text.trim() && cards.get(key(pid, turn))?.last?.kind !== "aside") return;
  const c = card(pid, turn);
  const n = block(c, "aside", () => Object.assign(document.createElement("div"), { className: "aside" }));
  n.textContent = (n.textContent + text).replace(/^\n+/, "");
  scrollFeed();
}
function feedTool(pid, turn, id, label, detail) {
  const c = card(pid, turn);
  const n = document.createElement("details");
  n.className = "tool";
  n.innerHTML = `<summary><span class="mark"><span class="spin"></span></span><span class="lbl">${esc(label)}</span><span class="res"></span></summary>`;
  if (detail) n.appendChild(Object.assign(document.createElement("pre"), { className: "io in", textContent: detail }));
  c.el.appendChild(n);
  c.last = { kind: "tool", node: n };
  c.tools.set(id, n);
  scrollFeed();
}
function feedToolResult(pid, turn, id, ok, summary, detail) {
  const n = cards.get(key(pid, turn))?.tools.get(id);
  if (!n) return;
  n.classList.add(ok ? "ok" : "bad");
  n.querySelector(".mark").textContent = ok ? "✓" : "✕";
  n.querySelector(".res").textContent = summary;
  if (detail) n.appendChild(Object.assign(document.createElement("pre"), { className: "io out", textContent: detail }));
}
function feedSaid(pid, turn, text, spoken) {
  const c = card(pid, turn);
  const n = block(c, "said", () => Object.assign(document.createElement("div"), { className: "said" }));
  if (!spoken) n.classList.add("quiet");
  n.textContent += (n.textContent ? " " : "") + text;
  scrollFeed();
}
function feedScreen(pid, turn, text) {
  const c = card(pid, turn);
  if (!c.screen) { c.screen = Object.assign(document.createElement("div"), { className: "screen" }); c.el.appendChild(c.screen); }
  c.screenMd += text;
  c.screen.innerHTML = renderMarkdown(c.screenMd.replace(/^\n+|\s+$/g, ""));
  scrollFeed();
}
/** One of the central agent's control tags, shown as what it will do rather than as markup. */
function feedAction(pid, turn, m) {
  const c = card(pid, turn);
  const target = m.attrs.name || m.attrs.to || m.attrs.path || m.attrs.folder || "";
  const words = { new: "new project", open: "open", delegate: "hand to", switch: "put on the line", park: "park", close: "close" }[m.name] ?? m.name;
  const n = Object.assign(document.createElement("div"), { className: "actchip" });
  n.innerHTML = `→ ${esc(words)} <b>${esc(target)}</b>${m.attrs.folder && m.attrs.name ? ` in ${esc(m.attrs.folder)}` : ""}${m.body ? `: ${esc(m.body.length > 160 ? m.body.slice(0, 159) + "…" : m.body)}` : ""}`;
  c.el.appendChild(n);
  c.last = { kind: "action", node: n };
  scrollFeed();
}
function feedError(pid, turn, text) {
  const c = card(pid, turn);
  if (!turn) c.el.querySelector(".qt").textContent = "Note";
  c.el.appendChild(Object.assign(document.createElement("div"), { className: "err", textContent: text }));
  scrollFeed();
}
function feedNote(text, pid) {
  addToFeed(Object.assign(document.createElement("div"), { className: "note", textContent: text }), pid);
  scrollFeed();
}
function finishCard(pid, turn, interrupted) {
  const c = cards.get(key(pid, turn));
  if (!c) return;
  c.el.querySelector(".st").textContent = interrupted ? "cut in" : "done";
  if (interrupted) c.el.classList.add("stale");
  c.el.querySelectorAll("details.think").forEach((d) => (d.open = false));
}

// ---------- notifications ----------
/**
 * News from projects that are not on the line. Each one rings at once — a soft chime and a ring
 * around the orb — so you know something is waiting, but it is only read out when you have gone
 * quiet: never while you are talking or typing, never while someone is mid-sentence, and not for
 * a moment after you stop, which is when you are most likely to carry on. "Updates" hears it now.
 */
function queueNotice(n) {
  const item = { ...n, uid: ++noticeSeq, status: "waiting" };
  notices.push(item);
  trayItem(item);
  feedNote(`${n.name}: ${n.text}`, n.project);
  ring(identityOf(n.project));
  scheduleDrain();
}

let ringFrom = null;
function ring(identity = ringFrom) {
  if (!onCall) return;
  // a chime under your voice is noise you will not hear; ring when you stop instead
  if (hearing) { ringAfterSpeech = true; ringFrom = identity; return; }
  earcons.ring(identity);
  const c = cardEls.get(centralId);
  c?.classList.remove("ring-flash");
  void c?.offsetWidth;
  c?.classList.add("ring-flash");
}

function scheduleDrain() {
  clearTimeout(relayTimer);
  if (!notices.some((n) => n.status === "waiting")) return;
  relayTimer = setTimeout(drainNotices, RELAY_SETTLE_MS);
}

function userBusy() {
  const typing = $("typeBox").value.trim() && Date.now() - lastTyped < TYPING_MS;
  return hearing || userPaused || typing || Date.now() - lastActivity < RELAY_SETTLE_MS;
}

function drainNotices({ now = false } = {}) {
  const waiting = notices.filter((n) => n.status === "waiting");
  if (!waiting.length || !onCall) return;
  if (!now && (userBusy() || !voice.idle)) return scheduleDrain();
  for (const n of waiting) {
    n.status = "told";
    n.toldAt = Date.now();
    trayItem(n);
    // finished work has been heard, and that is all it needed; blocking items stay until settled
    if (n.kind === "finished" || n.kind === "failed") setTimeout(() => dismiss(n), TOLD_LINGER_MS);
  }
  central.relay(waiting.length === 1 ? waiting[0].text : batchLine(waiting));
  render();
}

function batchLine(items) {
  const rank = { permission: 0, question: 1, failed: 2, finished: 3 };
  const sorted = [...items].sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at);
  const head = sorted.slice(0, 2).map((n) => n.text.replace(/\.$/, ""));
  const rest = sorted.length - 2;
  return `${sorted.length} updates. ${head.join(". And ")}.${rest > 0 ? ` And ${rest} more on screen.` : ""}`;
}

function dismiss(n) {
  const i = notices.indexOf(n);
  if (i < 0) return;
  notices.splice(i, 1);
  n.el?.remove();
  renderTrayCount();
  render();
}

/** A permission or a question is settled once the project stops waiting on it. */
function settleNotices() {
  for (const n of notices.slice()) {
    const p = project(n.project);
    if (!p) { dismiss(n); continue; }
    if (n.kind === "permission" && !p.waiting) dismiss(n);
    if (n.kind === "question" && !p.question) dismiss(n);
  }
}

function renderTrayCount() {
  $("trayCount").textContent = notices.length ? String(notices.length) : "";
  const tray = $("tray");
  const empty = tray.querySelector(".empty");
  if (empty) empty.style.display = notices.length ? "none" : "";
}

function trayItem(n) {
  if (!n.el) {
    n.el = document.createElement("div");
    n.el.className = `notice ${n.kind}`;
    const hue = identityOf(n.project)?.hue;
    if (hue !== undefined) n.el.style.setProperty("--hue", String(hue));
    n.el.innerHTML = `<div class="nhead"><b>${esc(n.name)}</b><span class="ntag"></span></div><div class="nbody"></div><div class="nacts"></div>`;
    n.el.querySelector(".nbody").textContent = n.kind === "question" ? n.detail : n.kind === "permission" ? `wants to ${n.text.replace(/^.*?permission to /, "").replace(/\. Say.*$/, "")}` : n.detail || n.text;
    const acts = n.el.querySelector(".nacts");
    const btn = (label, fn) => { const b = Object.assign(document.createElement("button"), { textContent: label }); b.onclick = fn; acts.appendChild(b); };
    if (n.kind === "permission") {
      btn("Allow", () => { send({ type: "grant", project: n.project }); central.granted(n.name); });
      btn("Deny", () => { send({ type: "deny", project: n.project }); central.denied(n.name); });
    }
    if (n.kind === "question") {
      const form = document.createElement("form");
      form.style.cssText = "display:flex;gap:6px;flex:1;min-width:100%";
      const input = Object.assign(document.createElement("input"), { placeholder: `answer ${n.name}…` });
      form.appendChild(input);
      form.onsubmit = (e) => {
        e.preventDefault();
        const v = input.value.trim();
        if (!v) return;
        send({ type: "tell", project: n.project, text: v });
        central.passedOn(n.name);
        dismiss(n);
      };
      acts.appendChild(form);
    }
    btn(`Talk to ${n.name}`, () => { if (onCall) { voice.clear(); send({ type: "focus", project: n.project }); } });
    if (n.kind === "finished" || n.kind === "failed") btn("✕", () => dismiss(n));
    const tray = $("tray");
    tray.insertBefore(n.el, tray.querySelector(".notice") ?? null);
  }
  n.el.classList.toggle("told", n.status === "told");
  n.el.querySelector(".ntag").textContent = n.status === "told" ? "told" : "waiting";
  renderTrayCount();
}

// ---------- server connection ----------
const pendingSegments = new Map();

// The access code is kept per device and sent as a subprotocol, never in the URL, so a link on
// its own is useless. A refused handshake closes with 1006 and no reason, so a connection that
// never opened is treated as a wrong code.
const CODE_KEY = "buddyCode";
const readCode = () => { try { return localStorage.getItem(CODE_KEY) || ""; } catch { return ""; } };
const saveCode = (c) => { try { localStorage.setItem(CODE_KEY, c); } catch {} };
const forgetCode = () => { try { localStorage.removeItem(CODE_KEY); } catch {} };
let code = readCode();
let everOpened = false;
let retry = 0;

function askForCode(message) {
  $("gateMsg").textContent = message ?? "";
  document.body.classList.add("locked");
  $("codeBox").value = "";
  $("codeBox").focus();
}

function connect() {
  if (!code) return askForCode("Enter the access code shown in the terminal where Buddy is running.");
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`, [`buddy.${code}`]);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => {
    everOpened = true;
    retry = 0;
    document.body.classList.remove("locked");
    saveCode(code);
    $("timer").textContent = onCall ? $("timer").textContent : "ready";
    if (onCall) send({ type: "call-start", mode: mode() });
  };
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  // a refused handshake reports an error, and only sometimes a close: treat either as the end
  ws.onerror = () => { if (!everOpened) ws.onclose?.(); };
  ws.onclose = () => {
    if (ws.closedHandled) return;
    ws.closedHandled = true;
    if (!everOpened) {
      // the handshake was refused: the code is wrong, or too many tries have been made
      forgetCode();
      code = "";
      return askForCode("That code was not accepted. Check the terminal and try again.");
    }
    $("ears").textContent = "reconnecting…";
    $("ears").className = "pill warn";
    retry = Math.min(retry + 1, 5);
    setTimeout(connect, 500 * retry);
  };
}

$("codeForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("codeBox").value.trim().toLowerCase();
  if (!v) return;
  code = v;
  everOpened = false;
  connect();
};
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function onServer(m) {
  const mine = m.project === undefined || m.project === focusedId;
  switch (m.type) {
    case "stt":
      $("ears").textContent = { loading: "ears loading…", ready: "ears ready", error: "server ears failed" }[m.state];
      $("ears").className = "pill " + (m.state === "ready" ? "ok" : "warn");
      break;
    case "central":
      centralIdentity = m.identity;
      centralId = m.id ?? centralId;
      centralName = m.name ?? centralName;
      homeDir = m.home ?? "";
      central.setIdentity(m.identity, centralId, centralName);
      break;
    case "roster": {
      const first = !rosterSeen;
      rosterSeen = true;
      projects = m.projects;
      const changed = focusedId !== m.focused;
      focusedId = m.focused;
      if (changed) {
        // pick up whatever the agent now on the line is in the middle of, so its voice plays
        const f = focused();
        currentTurn = f?.turn ?? 0;
        liveTurns = new Set([currentTurn]);
        working = f?.state === "working";
      }
      if (first) warnMissingVoices();
      if (greetPending) { greetPending = false; central.greet(workers()); }
      else if (changed && focusedId && onCall) central.focused(focused());
      settleNotices();
      break;
    }
    case "opened":
      activity.set(m.project, { text: "just opened", live: false });
      feedNote(`${centralName} opened ${m.name} in ${tilde(m.dir)}${m.resumed ? ", picking up its last conversation" : ""}.`, m.project);
      break;
    case "transcript": {
      const done = pendingSegments.get(m.id);
      pendingSegments.delete(m.id);
      done?.(m.text || "");
      break;
    }
    case "turn": {
      if (dropped.has(m.turn)) break;
      if (m.project === focusedId) {
        currentTurn = m.turn;
        working = true;
        if (m.queued) liveTurns.add(m.turn);
        else liveTurns = new Set([m.turn]);
      }
      const c = card(m.project, m.turn);
      if (m.queued && !c.el.querySelector(".bg")) c.el.querySelector(".who").insertAdjacentHTML("afterend", '<span class="bg">queued behind work</span>');
      c.el.querySelector(".qt").textContent = m.text;
      if (m.background && !c.el.querySelector(".bg")) c.el.querySelector(".who").insertAdjacentHTML("afterend", '<span class="bg">background</span>');
      activity.set(m.project, { text: m.text.length > 80 ? m.text.slice(0, 79) + "…" : m.text, live: true });
      scrollFeed();
      break;
    }
    case "say":
      feedSaid(m.project, m.turn, m.text, m.spoken);
      activity.set(m.project, { text: m.text, live: true });
      // only the agent on the line has a voice; the rest report through the central agent
      if (m.spoken && mine && liveTurns.has(m.turn)) voice.say(m.text, m.turn, { identity: identityOf(m.project), speaker: m.project });
      break;
    case "narrate":
      if (mine && !userPaused) voice.say(m.text, m.turn, { record: false, identity: identityOf(m.project), speaker: m.project });
      break;
    case "thinking": feedThinking(m.project, m.turn, m.text); break;
    case "aside": feedAside(m.project, m.turn, m.text); break;
    case "tool":
      feedTool(m.project, m.turn, m.id, m.label, m.detail);
      activity.set(m.project, { text: m.label, live: true });
      break;
    case "tool_result": feedToolResult(m.project, m.turn, m.id, m.ok, m.summary, m.detail); break;
    case "screen": feedScreen(m.project, m.turn, m.text); break;
    case "action": feedAction(m.project, m.turn, m); break;
    case "permission":
      feedNote(`${nameOf(m.project)}: ${m.text}`, m.project);
      activity.set(m.project, { text: `needs permission to use ${m.tool}`, live: false });
      break;
    case "notify": queueNotice(m); break;
    case "done":
      finishCard(m.project, m.turn, m.interrupted);
      activity.delete(m.project); // the card falls back to the agent's own report
      if (mine) {
        liveTurns.delete(m.turn);
        // a message queued behind this turn starts now, so the agent is still at work
        working = [...liveTurns].some((t) => t > m.turn);
      }
      break;
    case "error":
      feedError(m.project, m.turn ?? 0, m.text);
      if (mine) central.say("Sorry, I hit a problem. The details are on screen.");
      break;
  }
  render();
}

function warnMissingVoices() {
  const ws = workers();
  const missing = voice.missing(ws.map((p) => p.identity));
  if (missing.length) feedNote(`${missing.length} of ${ws.length} projects have no matching voice in this browser and will share a fallback. Chrome and Safari on macOS have the full set.`);
}

// ---------- what you said ----------
const norm = (t) => t.toLowerCase().replace(/[^\w' ]/g, " ").replace(/\s+/g, " ").trim();
let lastIgnored = null; // { t, at } so saying it again gets through

/** Never filtered as noise, however short: page commands and the names of agents on the call. */
const mustKeep = (t) => LOCAL.some((re) => re.test(t)) || projects.some((p) => t === norm(p.name) || t.startsWith(norm(p.name) + " "));

function heardText(raw, { typed = false, voicedMs = Infinity } = {}) {
  // a cough, a laugh, a door: loud and brief, and transcribed as a filler or a stock phrase
  const noise = !typed && isNoise(raw, voicedMs, mustKeep);
  if (noise && raw.trim()) feedNote(`Ignored as noise: “${raw.trim()}”`);
  if (noise) raw = "";
  if (!typed && hearing) { if (raw) carry = `${carry} ${raw}`.trim(); return; } // you are still talking: wait for the rest
  if (!typed && carry) { raw = `${carry} ${raw}`; carry = ""; }
  const text = raw.trim();
  const t = norm(text);
  // nothing, a breath, or a noise
  if (!t || t.length < 2) {
    if ((ducked || continuing) && !userPaused) voice.resume();
    ducked = continuing = false;
    showYou("—");
    render();
    return;
  }
  // Buddy hearing itself through the speakers. Headphones keep its voice off the mic, so there
  // is nothing to guard against; a local command is never treated as an echo; and saying the
  // same thing again within INSIST_MS always gets through, so a wrong call is never a dead end.
  const guarded = !typed && !$("phones").checked && !LOCAL.some((re) => re.test(t));
  if (guarded && voice.isEcho(text)) {
    const insisted = lastIgnored?.t === t && Date.now() - lastIgnored.at < INSIST_MS;
    if (!insisted) {
      lastIgnored = { t, at: Date.now() };
      if ((ducked || continuing) && !userPaused) voice.resume();
      ducked = continuing = false;
      showYou(`(heard that as my own echo: ${text}) — say it again and I will take it`);
      feedNote(`Ignored as an echo: “${text}”. Repeat it to override, or turn on headphones.`);
      render();
      return;
    }
  }
  lastIgnored = null;
  lastActivity = Date.now();
  showYou(text);
  ducked = false;

  if (continuing) {
    continuing = false;
    if (!typed && lastAsk && route(t, projects).kind === "ask") return ask(`${lastAsk.text} ${text}`, `${lastAsk.text} ${text}`, { merge: true });
    if (!userPaused) voice.resume();
  }

  const r = route(text, projects, { waiting: waitingId() });
  switch (r.kind) {
    case "local": return local(r.name);
    case "focus":
      voice.clear();
      userPaused = false;
      send({ type: "focus", project: r.project });
      return;
    case "address": return r.text ? ask(r.text, text, { project: r.project }) : send({ type: "focus", project: r.project });
    case "tell":
      send({ type: "tell", project: r.project, text: r.text });
      for (const n of notices.slice()) if (n.project === r.project && n.kind === "question") dismiss(n);
      central.passedOn(nameOf(r.project));
      return;
    case "grant":
      send({ type: "grant", project: r.project, scope: r.scope });
      central.granted(nameOf(r.project) || "It");
      return;
    case "deny":
      send({ type: "deny", project: r.project });
      central.denied(nameOf(r.project) || "It");
      return;
    case "park":
      send({ type: "park", project: r.project });
      central.parked(nameOf(r.project) || "It");
      return;
    default: return ask(r.text, text);
  }
}

function local(name) {
  switch (name) {
    case "pause": return pauseBuddy();
    case "resume": if (userPaused || voice.busy) return resumeBuddy(); return;
    case "stop":
      voice.clear();
      userPaused = false;
      liveTurns.clear();
      send({ type: "interrupt", project: focusedId });
      render();
      return;
    case "stop-all":
      voice.clear();
      userPaused = false;
      for (const p of projects) send({ type: "interrupt", project: p.id });
      central.stoppedAll(projects.filter((p) => p.state === "working").map((p) => p.name));
      render();
      return;
    case "sleep": return endCall("Going to sleep. Press call to wake me.");
    case "status":
      voice.clear();
      userPaused = false;
      central.status(projects, focusedId);
      return;
    case "updates":
      voice.clear();
      userPaused = false;
      if (notices.some((n) => n.status === "waiting")) drainNotices({ now: true });
      else central.nothingNew();
      return;
    case "repeat": {
      voice.clear();
      userPaused = false;
      const lines = voice.heard.length ? voice.heard : voice.lastTurnSpoken;
      for (const s of lines.slice()) voice.say(s, currentTurn, { record: false, identity: identityOf(focusedId), speaker: focusedId ?? centralId });
      return;
    }
    case "audio":
      $("audioOnly").checked = true;
      applyMode();
      central.say("Audio only. I will keep it all spoken.");
      return;
    case "visual":
      $("audioOnly").checked = false;
      applyMode();
      central.say("Screen is back.");
      return;
    case "shorter": return ask("Give me the shorter version of your last answer.", "shorter");
  }
}

function ask(prompt, shown, { merge = false, project: pid = null } = {}) {
  let context = null;
  // Talking never kills work. If the agent on the line is busy, what you said waits behind it,
  // and the work's own report still plays when it lands. Only "stop" cuts work off.
  // A merged sentence whose first half was queued stays queued, replacing that half.
  const queue = merge ? !!lastAsk?.queued : working && (!pid || pid === focusedId);
  if (merge && currentTurn > 0) {
    // replace the turn we just sent rather than cutting in on it: it was your own half-sentence
    dropped.add(currentTurn);
    liveTurns.delete(currentTurn);
    cards.get(key(focusedId, currentTurn))?.el.remove();
    cards.delete(key(focusedId, currentTurn));
    if (queue) context = { kind: "followup", working: true, queued: true, replace: true };
  } else if (voice.busy || working || userPaused) {
    voice.hold();
    const snap = voice.snapshot();
    context = {
      kind: userPaused ? "paused" : voice.busy ? "interrupted" : "followup",
      heard: snap.heard,
      unheard: snap.unheard,
      pausedMs: userPaused ? Date.now() - pausedAt : undefined,
      working,
      queued: queue || undefined,
    };
  }
  voice.clear();
  voice.newTurn();
  userPaused = false;
  if (currentTurn > 0 && !merge && !queue) finishCard(focusedId, currentTurn, working);
  lastAsk = { text: prompt, at: Date.now(), queued: queue };
  spokeThisTurn = false;
  if (!queue) {
    currentTurn = -1; // ignore the old turn's tail until the server names the new one
    liveTurns.clear();
  }
  send({ type: "utterance", project: pid ?? focusedId, text: prompt, context, mode: mode() });
  showYou(shown);
  render();
}

function pauseBuddy() {
  userPaused = true;
  pausedAt = Date.now();
  voice.hold();
  const snap = voice.snapshot();
  $("pausedAt").textContent = (snap.heard || "…").split(/\s+/).slice(-8).join(" ");
  render();
}
function resumeBuddy() {
  userPaused = false;
  ducked = false;
  voice.resume();
  render();
}

// ---------- the call ----------
async function startCall() {
  if (onCall) return;
  onCall = true;
  callStart = lastActivity = Date.now();
  $("callBtn").classList.add("end");
  $("callBtn").textContent = "✆";
  $("callBtn").title = "End call";
  for (const id of ["muteBtn", "pauseBtn", "typeBox"]) $(id).disabled = false;
  // a fresh roster is coming; greet from it, not from the last call's
  rosterSeen = false;
  greetPending = true;
  send({ type: "call-start", mode: mode() });
  // Safari only allows audio and speech that start inside the click, so do both before any await
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume?.();
  earcons.ctx = audioCtx;
  voice.unlock();
  central.hello();
  try {
    listener ??= await createVadListener({
      audioContext: audioCtx,
      onSpeechStart,
      onMisfire: () => {
        hearing = false;
        if (ringAfterSpeech) { ringAfterSpeech = false; ring(); }
        if (carry) { const c = carry; carry = ""; heardText(c); return; }
        if ((ducked || continuing) && !userPaused) voice.resume();
        ducked = continuing = false;
        render();
      },
      onSpeechEnd: (pcm, voicedMs) => {
        hearing = false;
        if (ringAfterSpeech) { ringAfterSpeech = false; ring(); }
        render();
        transcribe(pcm, voicedMs);
      },
      sensitivity: $("sensitivity").value,
      onLevel: (p) => callEl.style.setProperty("--level", p.toFixed(2)),
      processorType: new URLSearchParams(location.search).get("processor") === "script" ? "ScriptProcessor" : "auto",
    });
  } catch (err) {
    console.warn("VAD unavailable, using browser recognition", err);
    feedNote(`Using the browser's speech recognition instead (${err.message}).`);
    try {
      listener ??= createChromeListener({ onSpeechStart, onText: (t) => { hearing = false; heardText(t); } });
    } catch (e2) {
      feedError(focusedId, 0, `Buddy cannot hear on this browser: ${e2.message}. You can still type.`);
    }
  }
  if (!muted) startListening();
  clearInterval(sleepTimer);
  sleepTimer = setInterval(tick, 1000);
  render();
}

function endCall(message) {
  if (!onCall) return;
  onCall = false;
  clearInterval(sleepTimer);
  clearTimeout(relayTimer);
  for (const n of notices.slice()) dismiss(n);
  listener?.pause();
  voice.clear();
  userPaused = false;
  hearing = false;
  greetPending = false;
  send({ type: "call-end" });
  working = false;
  projects = [];
  focusedId = null;
  activity.clear();
  $("callBtn").classList.remove("end");
  $("callBtn").textContent = "📞";
  $("callBtn").title = "Start call";
  for (const id of ["muteBtn", "pauseBtn", "typeBox"]) $(id).disabled = true;
  $("timer").textContent = "call ended";
  if (message) central.say(message);
  render();
}

function onSpeechStart() {
  if (!onCall || muted) return;
  hearing = true;
  lastActivity = Date.now();
  // hold (not drop) the reply: if this turns out to be noise it plays on, if it is more of your sentence it is replaced
  if (lastAsk && Date.now() - lastAsk.at < MERGE_MS && !spokeThisTurn) { continuing = true; voice.hold(); }
  showYou("…", true);
  // with headphones Buddy's voice cannot reach the mic, so cut it off the moment you speak
  if ($("phones").checked && voice.speaking && !userPaused) { ducked = true; voice.hold(); }
  render();
}

function transcribe(pcm, voicedMs) {
  const id = String(++segSeq);
  showYou("…", true);
  pendingSegments.set(id, (text) => heardText(text, { voicedMs }));
  if (ws?.readyState !== 1) { pendingSegments.delete(id); showYou("(not connected)"); return; }
  send({ type: "segment", id });
  ws.send(pcm.buffer);
}

// sleep timer and call clock
const sleepInput = $("sleep");
try { sleepInput.value = localStorage.getItem("sleepMinutes") || "15"; } catch { sleepInput.value = "15"; }
const sleepMs = () => Math.min(60, Math.max(2, Number(sleepInput.value) || 15)) * 60_000;
sleepInput.onchange = () => { sleepInput.value = String(sleepMs() / 60_000); try { localStorage.setItem("sleepMinutes", sleepInput.value); } catch {} };
function tick() {
  const s = Math.floor((Date.now() - callStart) / 1000);
  $("timer").textContent = `on call · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  // speakers: be stricter while Buddy talks so its own voice does not trigger the mic
  listener?.strict(!$("phones").checked && voice.speaking);
  // a project still working, or an update waiting to be read out, keeps the call awake
  const busy = voice.busy || working || notices.some((n) => n.status === "waiting") || projects.some((p) => p.state === "working" || p.waiting || p.question);
  if (busy) { lastActivity = Math.max(lastActivity, Date.now() - sleepMs() + 30_000); return; }
  if (Date.now() - lastActivity > sleepMs()) endCall("Going to sleep. Press call to wake me.");
}

// ---------- controls ----------
$("callBtn").onclick = () => (onCall ? endCall() : startCall());
async function startListening() {
  try {
    await listener?.start();
  } catch (err) {
    feedError(focusedId, 0, `Buddy cannot open the microphone: ${err.message || err}`);
  }
}
$("muteBtn").onclick = () => {
  muted = !muted;
  $("muteBtn").classList.toggle("on", muted);
  $("muteBtn").textContent = muted ? "🔇" : "🎙️";
  muted ? listener?.pause() : startListening();
  render();
};
$("pauseBtn").onclick = () => (userPaused ? resumeBuddy() : pauseBuddy());
$("statusBtn").onclick = () => local("status");
$("nbadge").onclick = () => local("updates");
$("typeBox").oninput = () => { lastTyped = Date.now(); };
$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("typeBox").value.trim();
  $("typeBox").value = "";
  if (v) heardText(v, { typed: true });
};
try { $("sensitivity").value = localStorage.getItem("sensitivity") || "normal"; } catch {}
$("sensitivity").onchange = () => {
  listener?.sensitivity?.($("sensitivity").value);
  try { localStorage.setItem("sensitivity", $("sensitivity").value); } catch {}
};
function applyMode() { document.body.classList.toggle("audio", mode() === "audio"); }
$("audioOnly").onchange = applyMode;
try { $("phones").checked = localStorage.getItem("phones") === "1"; } catch {}
$("phones").onchange = () => { try { localStorage.setItem("phones", $("phones").checked ? "1" : "0"); } catch {} };
try { earcons.enabled = localStorage.getItem("earcons") !== "0"; $("earcons").checked = earcons.enabled; } catch { $("earcons").checked = true; }
$("earcons").onchange = () => { earcons.enabled = $("earcons").checked; try { localStorage.setItem("earcons", earcons.enabled ? "1" : "0"); } catch {} };
try { earcons.ringEnabled = localStorage.getItem("ring") !== "0"; $("ringToggle").checked = earcons.ringEnabled; } catch { $("ringToggle").checked = true; }
$("ringToggle").onchange = () => { earcons.ringEnabled = $("ringToggle").checked; try { localStorage.setItem("ring", earcons.ringEnabled ? "1" : "0"); } catch {} };
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space" && onCall) { e.preventDefault(); userPaused ? resumeBuddy() : pauseBuddy(); }
  // 0 is the central agent; 1–9 put a project on the line
  const n = Number(e.key);
  if (!onCall || !/^[0-9]$/.test(e.key)) return;
  const target = n === 0 ? centralId : workers()[n - 1]?.id;
  if (target) { voice.clear(); send({ type: "focus", project: target }); }
});

connect();
render();

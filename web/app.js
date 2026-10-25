import { Voice } from "./voice.js";
import { Earcons } from "./earcon.js";
import { Central } from "./central.js";
import { createVadListener, createChromeListener } from "./listen.js";
import { esc, renderMarkdown } from "./markdown.js";
import { route, LOCAL } from "./route.js";
import { isNoise } from "./noise.js";
import * as attention from "./attention.js";

// The call has three levels. You lead it. Ada is your assistant: she moves you between the team,
// sets projects up, and keeps track of who needs you. The team are the project agents, each its
// own Claude session; you talk to one of them at a time, and the rest work in the background.

const $ = (id) => document.getElementById(id);
const callEl = $("call"), orb = $("orb"), feed = $("feed");

// ---------- state ----------
let ws = null;
let onCall = false, muted = false;
let listener = null;
// Every agent on the call, as the server reports it: the assistant first, then the team.
let projects = [];
let focusedId = null;
let centralId = "ada", centralName = "Ada", centralIdentity = null, homeDir = "";
let currentTurn = 0; // the latest turn of the agent on the line
// Turns of the agent on the line whose speech is played. Usually just the latest; but something
// said while it was working is queued behind the work, and the work's own report still plays.
let liveTurns = new Set();
let working = false; // the agent on the line is busy
let userPaused = false, pausedAt = 0;
let ducked = false; // voice held because the user started talking
let hearing = false;
let callStart = 0, lastActivity = 0, sleepTimer = null;
let segSeq = 0;
let audioCtx = null;
let greetPending = false;
let rosterSeen = false;
// Speculative sending: each utterance goes to Claude the moment it is transcribed. If you keep
// talking within MERGE_MS and nothing has been said back yet, that turn is quietly replaced by
// one with your whole sentence, so a mid-sentence pause never cuts you off.
const MERGE_MS = 1500;
// Saying the same thing twice this close together overrides the echo guard.
const INSIST_MS = 12_000;
// Typing counts as talking: nothing is brought up while you are mid-sentence in the text box.
const TYPING_MS = 4000;
let lastAsk = null; // { text, at, queued }
let spokeThisTurn = false;
let continuing = false;
let carry = ""; // transcript that arrived while you were already talking again; joined to what comes next
let lastTyped = 0;
let ringAfterSpeech = false, ringFrom = null;
const dropped = new Set(); // turns replaced by a merged one; their late output is ignored
// What the team is waiting on you for: permissions, questions, and news. Nothing here is read
// out uninvited; the attention rules decide when to mention it and when to read it.
let queue = []; // { uid, project, name, kind, text, detail, requestId, questionId, at, onLine }
let queueSeq = 0;
let att = attention.createAttention();
let quietHandover = null; // a focus change the assistant has already spoken for
let talkingId = null; // whose voice is coming out right now
const activity = new Map(); // agent id -> { text, live }
const pipeline = new Map(); // new agent id -> { step, at }: seated, briefed, working, reported
const STEPS = ["seated", "briefed", "working", "reported"];
let filter = "all";
const mode = () => ($("audioOnly").checked ? "audio" : "visual");
const project = (id) => projects.find((p) => p.id === id) ?? null;
const focused = () => project(focusedId);
const team = () => projects.filter((p) => !p.central);
const identityOf = (id) => project(id)?.identity ?? (id === centralId ? centralIdentity : null);
const nameOf = (id) => project(id)?.name ?? (id === centralId ? centralName : id ?? "");
const tilde = (p) => (p ?? "").replace(/^\/Users\/[^/]+|^\/home\/[^/]+/, "~");
const ago = (at) => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m`; };

const earcons = new Earcons(null);
const voice = new Voice({
  earcons,
  onSentence: (text, from, record) => { if (record) { spokeThisTurn = true; } showBuddy(text, from, from); render(); },
  onWord: (text, at, len) => { showBuddy(text, at, at + Math.max(len, 1)); orb.classList.add("beat"); setTimeout(() => orb.classList.remove("beat"), 110); },
  onSpeaker: (speaker) => { talkingId = speaker; $("capWho").textContent = nameOf(speaker); render(); },
  onIdle: () => { talkingId = null; render(); },
});
const central = new Central({ voice, identity: null });

// ---------- view ----------
// Everything on screen is redrawn at most once a frame, however fast the team is streaming.
let framePending = false;
function render() {
  if (framePending) return;
  framePending = true;
  requestAnimationFrame(() => { framePending = false; draw(); });
}

function draw() {
  let s;
  if (!onCall) s = "asleep";
  else if (hearing) s = "hearing";
  else if (userPaused) s = "paused";
  else if (voice.speaking) s = "speaking";
  else if (working) s = "thinking";
  else s = muted ? "muted" : "listening";
  callEl.dataset.state = s === "muted" ? "listening" : s;
  $("stateLabel").textContent = { hearing: "hearing you", speaking: talkingId && talkingId !== focusedId ? `${nameOf(talkingId)} speaking` : "speaking", thinking: "working", listening: "listening", paused: "paused", asleep: "asleep", muted: "muted" }[s];
  document.body.classList.toggle("is-paused", userPaused);
  document.body.classList.toggle("oncall", onCall);
  $("pauseBtn").textContent = userPaused ? "▶" : "⏸";
  $("feedState").innerHTML = working ? '<span class="spin"></span> working' : "";
  const f = focused();
  const name = f?.name ?? centralName;
  callEl.style.setProperty("--hue", String(f?.identity?.hue ?? centralIdentity?.hue ?? 18));
  $("onLine").textContent = name;
  $("onLineRole").textContent = !f || f.central ? "your assistant" : tilde(f.dir);
  orb.textContent = name[0] ?? "";
  const waiting = queue.length;
  document.body.classList.toggle("has-notices", waiting > 0 && onCall);
  $("nbadge").textContent = String(waiting);
  for (const id of ["standupBtn", "newBtn", "holdBtn"]) $(id).disabled = !onCall;
  $("holdBtn").textContent = att.hold ? "Take calls" : "Hold calls";
  drawHead();
  drawTray();
  drawTable();
  drawFilters();
}

function drawHead() {
  const c = projects.find((p) => p.central) ?? { id: centralId, name: centralName, central: true, identity: centralIdentity ?? { hue: 18 } };
  let el = $("headCard").firstElementChild;
  if (!el) {
    el = document.createElement("div");
    el.className = "headcard";
    el.innerHTML = `<span class="av big"></span><div><div class="role">your assistant</div><div class="nm"></div><div class="sub"></div><div class="listening"><i></i><i></i><i></i><i></i></div></div>`;
    el.onclick = () => focusOn(centralId);
    $("headCard").appendChild(el);
  }
  el.style.setProperty("--hue", String(c.identity?.hue ?? 18));
  el.classList.toggle("on", focusedId === centralId);
  el.querySelector(".av").textContent = c.name[0];
  el.querySelector(".nm").textContent = c.name;
  const n = queue.length;
  el.querySelector(".sub").textContent = !onCall ? "Start the call to begin."
    : att.hold ? `Holding your calls${n ? ` · ${n} waiting` : ""}`
    : n ? `${n} waiting for you · I'll mention it when you're free`
    : focusedId === centralId ? "With you now" : `Keeping track while you talk to ${nameOf(focusedId)}`;
}

const handEls = new Map(); // queue uid -> element
function drawTray() {
  const tray = $("tray");
  const items = attention.order(queue);
  for (const [uid, el] of handEls) if (!items.some((i) => i.uid === uid)) { el.remove(); handEls.delete(uid); }
  const els = items.map(handCard);
  const empty = tray.querySelector(".empty");
  els.forEach((el, i) => { const at = tray.children[i + (empty ? 1 : 0)]; if (at !== el) tray.insertBefore(el, at ?? null); });
  if (empty) empty.style.display = items.length ? "none" : "";
  $("trayCount").textContent = items.length ? String(items.length) : "";
}

function handCard(item) {
  let el = handEls.get(item.uid);
  if (!el) {
    el = document.createElement("div");
    el.className = `hand ${item.kind}`;
    el.style.setProperty("--hue", String(identityOf(item.project)?.hue ?? 18));
    const kind = { permission: "needs a yes", question: "has a question", blocked: "was stopped", failed: "hit a problem", finished: "finished" }[item.kind] ?? item.kind;
    el.innerHTML = `<div class="hh"><span class="av mini">${esc(item.name[0] ?? "")}</span><b>${esc(item.name)}</b><span class="kind">${kind}</span><span class="age"></span></div><div class="what"></div>`;
    el.querySelector(".what").textContent = item.text.replace(new RegExp(`^${item.name}( asks:)? `), "");
    const [cmd, ...why] = String(item.detail ?? "").split("\n");
    if (item.kind === "permission" && cmd) el.appendChild(Object.assign(document.createElement("pre"), { textContent: cmd }));
    if (item.kind === "permission" && why.join(" ").trim()) el.appendChild(Object.assign(document.createElement("div"), { className: "why", textContent: why.join(" ") }));
    const acts = Object.assign(document.createElement("div"), { className: "acts" });
    const btn = (label, cls, fn) => { const b = Object.assign(document.createElement("button"), { textContent: label, className: cls }); b.onclick = (e) => { e.stopPropagation(); fn(); }; acts.appendChild(b); };
    if (item.kind === "permission") {
      btn("Allow", "yes", () => answerItem(item, { type: "grant", scope: "once" }));
      btn("Always", "", () => answerItem(item, { type: "grant", scope: "always" }));
      btn("Deny", "no", () => answerItem(item, { type: "deny" }));
    }
    if (item.kind === "question") {
      const form = document.createElement("form");
      const input = Object.assign(document.createElement("input"), { placeholder: `answer ${item.name}…` });
      form.appendChild(input);
      form.onsubmit = (e) => { e.preventDefault(); if (input.value.trim()) answerItem(item, { type: "tell", text: input.value.trim() }); };
      el.appendChild(form);
    }
    btn("Take me there", "", () => focusOn(item.project));
    if (item.kind !== "permission" && item.kind !== "question") btn("✕", "", () => removeItem(item));
    el.appendChild(acts);
    handEls.set(item.uid, el);
  }
  el.classList.toggle("told", att.item?.uid === item.uid);
  el.querySelector(".age").textContent = att.item?.uid === item.uid ? "asking now" : ago(item.at);
  return el;
}

const seatEls = new Map(); // agent id -> element, updated in place rather than rebuilt
function seat(p) {
  let el = seatEls.get(p.id);
  if (!el) {
    el = document.createElement("div");
    el.className = "seat";
    el.setAttribute("role", "button");
    el.tabIndex = 0;
    el.innerHTML = `<span class="handup">✋</span><div class="tools"></div><div class="top"><span class="av"></span><div><div class="nm"></div><div class="st"></div></div></div><div class="doing"></div><div class="stepwrap"></div><div class="meta"></div>`;
    const tools = el.querySelector(".tools");
    const tool = (label, title, fn) => { const b = Object.assign(document.createElement("button"), { textContent: label, title }); b.onclick = (e) => { e.stopPropagation(); fn(); }; tools.appendChild(b); };
    tool("⏏", "Park: stop this agent, keep its conversation", () => send({ type: "park", project: p.id }));
    tool("✕", "Take off the team (the folder is kept)", () => { if (confirm(`Take ${p.name} off the team? Its folder and conversation stay on disk.`)) send({ type: "remove", project: p.id }); });
    el.onclick = () => focusOn(p.id);
    el.onkeydown = (e) => { if (e.key === "Enter") focusOn(p.id); };
    seatEls.set(p.id, el);
  }
  const waitingItem = queue.find((i) => i.project === p.id && (i.kind === "permission" || i.kind === "question"));
  el.classList.toggle("on", p.id === focusedId);
  el.classList.toggle("talking", p.id === talkingId);
  el.classList.toggle("raised", !!waitingItem);
  el.dataset.state = p.state;
  el.style.setProperty("--hue", String(p.identity?.hue ?? 0));
  el.querySelector(".av").textContent = p.name[0];
  el.querySelector(".nm").textContent = p.name;
  el.querySelector(".st").textContent = p.id === focusedId ? "talking with you" : waitingItem ? (waitingItem.kind === "question" ? "has a question for you" : "needs your yes") : { working: "working", warm: "free", cold: "not started", parked: "parked", blocked: "waiting" }[p.state] ?? p.state;
  const a = activity.get(p.id);
  const doing = el.querySelector(".doing");
  doing.textContent = a?.text || p.question || p.report || (p.state === "cold" ? "Ready when you are." : "");
  doing.classList.toggle("live", !!a?.live && p.state === "working");
  const pipe = pipeline.get(p.id);
  const wrap = el.querySelector(".stepwrap");
  if (pipe && (pipe.step < 3 || Date.now() - pipe.at < 20_000)) {
    wrap.innerHTML = `<div class="steps">${STEPS.map((_, i) => `<span class="${i < pipe.step ? "done" : i === pipe.step ? (pipe.step === 3 ? "done" : "now") : ""}"></span>`).join("")}</div><div class="steplabel">${STEPS[pipe.step]}</div>`;
  } else wrap.innerHTML = "";
  el.querySelector(".meta").textContent = [tilde(p.dir), p.resumed ? "resumed" : p.sessionId ? "own session" : "", p.turns ? `${p.turns} turn${p.turns > 1 ? "s" : ""}` : ""].filter(Boolean).join(" · ");
  el.title = `${p.name}: ${p.dir}${p.sessionId ? ` · session ${p.sessionId.slice(0, 8)}` : ""}`;
  return el;
}

let addSeat = null;
function drawTable() {
  const list = team();
  for (const id of seatEls.keys()) if (!list.some((p) => p.id === id)) seatEls.delete(id);
  if (!addSeat) {
    addSeat = document.createElement("div");
    addSeat.className = "seat add";
    addSeat.innerHTML = `<span class="plus">+</span><span>New agent<br><span style="font-size:11px">or ask ${esc(centralName)}</span></span>`;
    addSeat.onclick = openNewProject;
  }
  const els = [...list.map(seat), addSeat];
  const table = $("table");
  els.forEach((el, i) => { if (table.children[i] !== el) table.insertBefore(el, table.children[i] ?? null); });
  while (table.children.length > els.length) table.lastChild.remove();
  addSeat.style.display = onCall ? "" : "none";
  $("projCount").textContent = list.length ? String(list.length) : "";
  $("projCount").title = "Each agent is its own Claude session, in its own folder.";
}

function drawFilters() {
  const want = ["all", ...projects.map((p) => p.id)];
  const el = $("filters");
  if (el.dataset.ids !== want.join(",")) {
    el.dataset.ids = want.join(",");
    el.innerHTML = "";
    for (const id of want) {
      const b = document.createElement("button");
      b.dataset.id = id;
      if (id === "all") b.textContent = "All";
      else { b.style.setProperty("--hue", String(identityOf(id)?.hue ?? 0)); b.innerHTML = `<span class="dot"></span>${esc(nameOf(id))}`; }
      b.onclick = () => { filter = id; applyFilter(); drawFilters(); };
      el.appendChild(b);
    }
    if (!want.includes(filter)) { filter = "all"; applyFilter(); }
  }
  for (const b of el.children) b.classList.toggle("on", b.dataset.id === filter);
}

function applyFilter(node) {
  for (const n of node ? [node] : feed.children) n.style.display = filter === "all" || !n.dataset.pid || n.dataset.pid === filter ? "" : "none";
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
  c = { el, last: null, screen: null, screenMd: "", screenPending: false, tools: new Map() };
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
let scrollPending = false;
const scrollFeed = () => {
  if (scrollPending) return;
  scrollPending = true;
  requestAnimationFrame(() => { scrollPending = false; if (feed.scrollHeight - feed.scrollTop - feed.clientHeight < 200) feed.scrollTop = feed.scrollHeight; });
};
function feedThinking(pid, turn, text) {
  const c = card(pid, turn);
  const d = block(c, "think", () => { const d = document.createElement("details"); d.className = "think"; d.open = true; d.innerHTML = "<summary>thinking</summary><div></div>"; return d; });
  d.lastChild.appendChild(document.createTextNode(text));
  scrollFeed();
}
function feedAside(pid, turn, text) {
  if (!text.trim() && cards.get(key(pid, turn))?.last?.kind !== "aside") return;
  const c = card(pid, turn);
  const n = block(c, "aside", () => Object.assign(document.createElement("div"), { className: "aside" }));
  n.appendChild(document.createTextNode(n.childNodes.length ? text : text.replace(/^\n+/, "")));
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
  n.appendChild(document.createTextNode((n.childNodes.length ? " " : "") + text));
  scrollFeed();
}
/** Screen markdown streams in small pieces; it is re-rendered once a frame, not once a piece. */
function feedScreen(pid, turn, text) {
  const c = card(pid, turn);
  if (!c.screen) { c.screen = Object.assign(document.createElement("div"), { className: "screen" }); c.el.appendChild(c.screen); }
  c.screenMd += text;
  if (c.screenPending) return;
  c.screenPending = true;
  requestAnimationFrame(() => { c.screenPending = false; c.screen.innerHTML = renderMarkdown(c.screenMd.replace(/^\n+|\s+$/g, "")); scrollFeed(); });
}
/** One of the assistant's control tags, shown as what it will do rather than as markup. */
function feedAction(pid, turn, m) {
  const c = card(pid, turn);
  const target = m.attrs.name || m.attrs.to || m.attrs.path || m.attrs.folder || "";
  const words = { new: "seat a new agent", open: "open", delegate: "hand to", switch: "give the floor to", park: "park", close: "take off the team" }[m.name] ?? m.name;
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
function feedNote(text, pid, problem = false) {
  addToFeed(Object.assign(document.createElement("div"), { className: `note${problem ? " problem" : ""}`, textContent: text }), pid);
  scrollFeed();
}
function finishCard(pid, turn, interrupted) {
  const c = cards.get(key(pid, turn));
  if (!c) return;
  c.el.querySelector(".st").textContent = interrupted ? "cut in" : "done";
  if (interrupted) c.el.classList.add("stale");
  c.el.querySelectorAll("details.think").forEach((d) => (d.open = false));
}

// ---------- the queue, and the assistant's attention ----------
/** Something from the team arrives. It rings, it shows, and it waits; it is not read out. */
function enqueue(m) {
  // the agent you are talking to just finished: that is not news, you were there
  if ((m.kind === "finished" || m.kind === "failed") && m.project === focusedId) return;
  const item = { ...m, uid: ++queueSeq, at: m.at ?? Date.now() };
  queue.push(item);
  feedNote(`${m.name}: ${m.text}`, m.project);
  ring(identityOf(m.project));
  // a request from whoever you are talking to is part of that conversation: ask it now
  if (item.onLine && item.project === focusedId && !att.hold) obey(attention.urgent(att, item, Date.now()));
  render();
}

function removeItem(item) {
  queue = queue.filter((i) => i.uid !== item.uid);
  if (att.item?.uid === item.uid) att = { ...att, mode: "normal", item: null };
  render();
}

/** Carry out what the attention rules decided. Returns true if the words were not hers to handle. */
function obey(result) {
  att = result.state;
  for (const line of result.say) central.say(line);
  let passthrough = false;
  for (const a of result.actions) {
    if (a.type === "passthrough") passthrough = true;
    else if (a.type === "dismiss") removeItem(a.item);
    else if (a.type === "focus") { quietHandover = a.project; voice.clear(); send({ type: "focus", project: a.project }); }
    else settle(a.item, a);
  }
  render();
  return passthrough;
}

/** Answer an item: from a button, or from the attention rules after the lead said yes or no. */
function settle(item, a) {
  if (a.type === "grant") send({ type: "grant", project: item.project, requestId: item.requestId, scope: a.scope });
  if (a.type === "deny") send({ type: "deny", project: item.project, requestId: item.requestId });
  if (a.type === "tell") send({ type: "tell", project: item.project, text: a.text });
  removeItem(item);
}

/** A button press on a queued item: answered at once, confirmed out loud. */
function answerItem(item, a) {
  settle(item, a);
  if (a.type === "grant") central.granted(item.name);
  if (a.type === "deny") central.denied(item.name);
  if (a.type === "tell") central.passedOn(item.name);
}

/** Keep the queue honest: what the server no longer has waiting is gone from here too. */
function reconcile() {
  for (const item of queue.slice()) {
    const p = project(item.project);
    if (!p) { removeItem(item); continue; }
    if (item.kind === "permission" && !(p.asks ?? []).some((x) => x.requestId === item.requestId)) removeItem(item);
    if (item.kind === "question" && (!p.question || (item.questionId && p.questionId !== item.questionId))) removeItem(item);
  }
}

function ring(identity) {
  if (!onCall) return;
  // a chime under your voice is noise you will not hear; ring when you stop instead
  if (hearing) { ringAfterSpeech = true; ringFrom = identity; return; }
  earcons.ring(identity);
}

/** Bring the lead to an agent: by name, by click, by "next" or "take me there". */
function focusOn(id) {
  if (!onCall || !id) return;
  voice.clear();
  userPaused = false;
  send({ type: "focus", project: id });
}

/** Stand-up: once round the table, each agent in its own voice with its own latest line. */
function standup() {
  const list = team();
  voice.clear();
  central.standupIntro(list.length);
  for (const p of list) {
    const waitingItem = queue.find((i) => i.project === p.id && (i.kind === "permission" || i.kind === "question"));
    const line = p.state === "working" ? `${p.name} here. Still working${activity.get(p.id)?.text ? `: ${activity.get(p.id).text.replace(/\.$/, "")}` : ""}.`
      : p.report ? `${p.name} here. ${p.report}` : central.standupEmpty(p.name);
    voice.say(waitingItem ? `${line} And I'm waiting on you.` : line, 0, { record: false, identity: p.identity, speaker: p.id });
  }
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
    if (!onCall) $("timer").textContent = "ready";
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
    if (closing) return;
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
      reconcile();
      if (changed) {
        // pick up whatever the agent now on the line is in the middle of, so its voice plays
        const f = focused();
        currentTurn = f?.turn ?? 0;
        liveTurns = new Set([currentTurn]);
        working = f?.state === "working";
        // its news is no longer news: you are talking to it now
        for (const i of queue.slice()) if (i.project === focusedId && (i.kind === "finished" || i.kind === "failed" || i.kind === "blocked")) removeItem(i);
      }
      if (first) warnMissingVoices();
      if (greetPending) { greetPending = false; central.greet(team()); }
      else if (changed && focusedId && onCall) {
        if (quietHandover !== focusedId) central.handover(focused());
        // what this agent is waiting on you for is part of the conversation now: ask it
        const pending = attention.order(queue).find((i) => i.project === focusedId && (i.kind === "permission" || i.kind === "question"));
        if (pending && quietHandover !== focusedId) obey(attention.urgent(att, pending, Date.now()));
      }
      if (changed) quietHandover = null;
      break;
    }
    case "opened":
      pipeline.set(m.project, { step: 0, at: Date.now() });
      activity.set(m.project, { text: m.resumed ? "Back, with its last conversation." : "Just seated.", live: false });
      feedNote(`${centralName} seated ${m.name} in ${tilde(m.dir)}${m.resumed ? ", picking up its last conversation" : ""}.`, m.project);
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
      c.el.querySelector(".qt").textContent = m.text;
      const tag = m.assigned ? "from Ada" : m.queued ? "queued behind work" : m.background ? "background" : "";
      if (tag && !c.el.querySelector(".bg")) c.el.querySelector(".who").insertAdjacentHTML("afterend", `<span class="bg">${tag}</span>`);
      activity.set(m.project, { text: m.text.length > 90 ? m.text.slice(0, 89) + "…" : m.text, live: true });
      const pipe = pipeline.get(m.project);
      if (pipe && m.assigned && pipe.step < 1) pipeline.set(m.project, { step: 1, at: Date.now() });
      scrollFeed();
      break;
    }
    case "say":
      feedSaid(m.project, m.turn, m.text, m.spoken);
      activity.set(m.project, { text: m.text, live: true });
      bumpPipeline(m.project, 2);
      // only the agent on the line has a voice; the rest wait in the queue
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
      bumpPipeline(m.project, 2);
      break;
    case "tool_result": feedToolResult(m.project, m.turn, m.id, m.ok, m.summary, m.detail); break;
    case "screen": feedScreen(m.project, m.turn, m.text); break;
    case "action": feedAction(m.project, m.turn, m); break;
    case "permission":
      feedNote(`${nameOf(m.project)} ${m.blocked ? "was stopped by the safety check" : `is waiting for your yes: ${m.phrase ?? m.tool}`}${m.detail ? ` — ${m.detail}` : ""}`, m.project);
      activity.set(m.project, { text: m.blocked ? "Stopped by the safety check." : `Waiting for your yes: ${m.phrase ?? m.tool}`, live: false });
      break;
    case "answered":
      for (const i of queue.slice()) if (i.requestId === m.requestId) removeItem(i);
      feedNote(`${nameOf(m.project)}: ${m.allow ? (m.always ? "allowed from now on" : "allowed") : "denied"} — ${m.phrase}`, m.project);
      break;
    case "notify": enqueue(m); break;
    case "picked": picked(m); break;
    case "note": feedNote(m.text, m.project, !!m.problem); if (m.problem && onCall) central.say(m.text.split(/(?<=\.)\s/)[0]); break;
    case "done":
      finishCard(m.project, m.turn, m.interrupted);
      activity.delete(m.project); // the seat falls back to the agent's own report
      if (!m.interrupted) bumpPipeline(m.project, 3);
      if (mine) {
        liveTurns.delete(m.turn);
        // a message queued behind this turn starts now, so the agent is still at work
        working = [...liveTurns].some((t) => t > m.turn);
      }
      break;
    case "error":
      feedError(m.project, m.turn ?? 0, m.text);
      if (mine) central.say("Sorry, that hit a problem. The details are on screen.");
      break;
  }
  render();
}

function bumpPipeline(id, step) {
  const pipe = pipeline.get(id);
  if (pipe && pipe.step < step && pipe.step < 3) pipeline.set(id, { step, at: Date.now() });
}

function warnMissingVoices() {
  const list = team();
  const missing = voice.missing(list.map((p) => p.identity));
  if (missing.length) feedNote(`${missing.length} of ${list.length} agents have no matching voice in this browser and will share a fallback. Chrome and Safari on macOS have the full set.`);
}

// ---------- what you said ----------
const norm = (t) => t.toLowerCase().replace(/[^\w' ]/g, " ").replace(/\s+/g, " ").trim();
let lastIgnored = null; // { t, at } so saying it again gets through

/** Never filtered as noise, however short: page commands, the assistant's yes/no words, and names. */
const mustKeep = (t) => LOCAL.some((re) => re.test(t)) || attention.classify(t) !== null || projects.some((p) => t === norm(p.name) || t.startsWith(norm(p.name) + " "));

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
  // Hearing its own voice through the speakers. Headphones keep it off the mic, so there is
  // nothing to guard against; a command or a yes/no is never treated as an echo; and saying the
  // same thing again within INSIST_MS always gets through, so a wrong call is never a dead end.
  const guarded = !typed && !$("phones").checked && !mustKeep(t);
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

  const r = route(text, projects, { waiting: attention.order(queue).find((i) => i.kind === "permission")?.project ?? null });

  // The assistant just asked something. A short reply is the answer to it; so is anything said
  // in reply to a question she read out. A command or a name goes where it always goes.
  if (att.mode !== "normal") {
    if (r.kind === "ask" || attention.classify(text) !== null) {
      if (!obey(attention.heard(att, text, queue, Date.now()))) return;
    } else att = { ...att, mode: "normal", item: null };
  }

  if (continuing) {
    continuing = false;
    if (!typed && lastAsk && r.kind === "ask") return ask(`${lastAsk.text} ${text}`, `${lastAsk.text} ${text}`, { merge: true });
    if (!userPaused) voice.resume();
  }

  switch (r.kind) {
    case "local": return local(r.name);
    case "focus": return focusOn(r.project);
    case "address": return r.text ? ask(r.text, text, { project: r.project }) : focusOn(r.project);
    case "tell":
      send({ type: "tell", project: r.project, text: r.text });
      for (const i of queue.slice()) if (i.project === r.project && i.kind === "question") removeItem(i);
      central.passedOn(nameOf(r.project));
      return;
    case "grant": {
      const item = queue.find((i) => i.project === r.project && i.kind === "permission");
      send({ type: "grant", project: r.project, requestId: item?.requestId, scope: r.scope });
      if (item) removeItem(item);
      central.granted(nameOf(r.project) || "It");
      return;
    }
    case "deny": {
      const item = queue.find((i) => i.project === r.project && i.kind === "permission");
      send({ type: "deny", project: r.project, requestId: item?.requestId });
      if (item) removeItem(item);
      central.denied(nameOf(r.project) || "It");
      return;
    }
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
    case "sleep": return endCall("Bye for now. Press call when you need me.");
    case "status":
      voice.clear();
      userPaused = false;
      central.status(projects, focusedId);
      return;
    case "updates":
      voice.clear();
      userPaused = false;
      obey(attention.review(att, queue, Date.now()));
      return;
    case "next":
      voice.clear();
      userPaused = false;
      obey(attention.next(att, queue, Date.now()));
      return;
    case "hold":
      att = { ...att, hold: true };
      central.held();
      render();
      return;
    case "unhold":
      att = { ...att, hold: false, lastHeadsUp: 0, announced: new Set() };
      central.unheld();
      render();
      return;
    case "standup": return standup();
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
      central.say("Audio only. I'll keep it all spoken.");
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
  const queued = merge ? !!lastAsk?.queued : working && (!pid || pid === focusedId);
  if (merge && currentTurn > 0) {
    // replace the turn we just sent rather than cutting in on it: it was your own half-sentence
    dropped.add(currentTurn);
    liveTurns.delete(currentTurn);
    cards.get(key(focusedId, currentTurn))?.el.remove();
    cards.delete(key(focusedId, currentTurn));
    if (queued) context = { kind: "followup", working: true, queued: true, replace: true };
  } else if (voice.busy || working || userPaused) {
    voice.hold();
    const snap = voice.snapshot();
    context = {
      kind: userPaused ? "paused" : voice.busy ? "interrupted" : "followup",
      heard: snap.heard,
      unheard: snap.unheard,
      pausedMs: userPaused ? Date.now() - pausedAt : undefined,
      working,
      queued: queued || undefined,
    };
  }
  voice.clear();
  voice.newTurn();
  userPaused = false;
  if (currentTurn > 0 && !merge && !queued) finishCard(focusedId, currentTurn, working);
  lastAsk = { text: prompt, at: Date.now(), queued };
  spokeThisTurn = false;
  if (!queued) {
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
  $("callBtn").title = "End the call";
  for (const id of ["muteBtn", "pauseBtn", "typeBox"]) $(id).disabled = false;
  // a fresh team is coming; greet from it, not from the last call's
  rosterSeen = false;
  greetPending = true;
  att = attention.createAttention();
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
        if (ringAfterSpeech) { ringAfterSpeech = false; ring(ringFrom); }
        if (carry) { const c = carry; carry = ""; heardText(c); return; }
        if ((ducked || continuing) && !userPaused) voice.resume();
        ducked = continuing = false;
        render();
      },
      onSpeechEnd: (pcm, voicedMs) => {
        hearing = false;
        if (ringAfterSpeech) { ringAfterSpeech = false; ring(ringFrom); }
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
  queue = [];
  att = attention.createAttention();
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
  pipeline.clear();
  $("callBtn").classList.remove("end");
  $("callBtn").textContent = "📞";
  $("callBtn").title = "Start the call";
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
  // with headphones the voice cannot reach the mic, so cut it off the moment you speak
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

// sleep timer, call clock, and the assistant's sense of a quiet moment
const sleepInput = $("sleep");
try { sleepInput.value = localStorage.getItem("sleepMinutes") || "15"; } catch { sleepInput.value = "15"; }
const sleepMs = () => Math.min(60, Math.max(2, Number(sleepInput.value) || 15)) * 60_000;
sleepInput.onchange = () => { sleepInput.value = String(sleepMs() / 60_000); try { localStorage.setItem("sleepMinutes", sleepInput.value); } catch {} };
function tick() {
  const now = Date.now();
  const s = Math.floor((now - callStart) / 1000);
  $("timer").textContent = `on call · ${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  // speakers: be stricter while a voice is talking so it does not trigger the mic
  listener?.strict(!$("phones").checked && voice.speaking);
  // an answer window stays open while the assistant is still talking, and lapses after
  att = attention.tick(att, now, { speaking: !voice.idle });
  // in a quiet moment, say who is waiting — never what about
  const typing = $("typeBox").value.trim() && now - lastTyped < TYPING_MS;
  const quietMs = typing ? 0 : now - Math.max(lastActivity, lastTyped);
  if (attention.wantsHeadsUp(att, queue, { now, quietMs, voiceIdle: voice.idle, hearing })) obey(attention.headsUp(att, queue, now));
  // an agent still working, or someone waiting on you, keeps the call awake
  const busy = voice.busy || working || queue.length || projects.some((p) => p.state === "working");
  if (busy) lastActivity = Math.max(lastActivity, now - sleepMs() + 30_000);
  else if (now - lastActivity > sleepMs()) endCall("Going to sleep. Press call to wake me.");
  render();
}

// ---------- new agent ----------
// Name, the folder it works in (chosen in the lead's own file manager), and optionally its own
// instructions and a first task. Exact, so it goes straight to the server with no model involved.
function openNewProject() {
  if (!onCall) return;
  $("newForm").reset();
  $("pickNote").textContent = "";
  $("newDlg").showModal();
}
$("browseBtn").onclick = () => {
  $("pickNote").textContent = "A folder chooser has opened on this computer…";
  $("browseBtn").disabled = true;
  send({ type: "pick-folder" });
};
function picked(m) {
  $("browseBtn").disabled = false;
  if (m.path) {
    $("newForm").elements.path.value = m.path;
    $("pickNote").textContent = "";
    // an agent named after its folder is the usual case, so offer that when no name is set yet
    const name = $("newForm").elements.name;
    if (!name.value.trim()) name.value = (m.path.split("/").filter(Boolean).pop() ?? "").replace(/[^a-zA-Z0-9]+/g, " ").trim().split(" ")[0].replace(/^./, (c) => c.toUpperCase());
  } else $("pickNote").textContent = m.error ?? "No folder chosen.";
}
$("newDlg").addEventListener("close", () => {
  if ($("newDlg").returnValue !== "ok") return;
  const f = new FormData($("newForm"));
  const name = String(f.get("name") ?? "").trim();
  const path = String(f.get("path") ?? "").trim();
  const m = { type: "create", name, prompt: String(f.get("prompt") ?? "").trim(), brief: String(f.get("brief") ?? "").trim(), focus: !!f.get("focus") };
  // no folder given: a new one in the assistant's home, named after the agent
  if (path) m.path = path;
  else m.folder = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (!name) return;
  send(m);
  feedNote(`Seating ${name}${path ? ` in ${tilde(path)}` : ""}…`);
});

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
$("standupBtn").onclick = () => local("standup");
$("newBtn").onclick = openNewProject;
$("holdBtn").onclick = () => local(att.hold ? "unhold" : "hold");
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
  if (e.target.tagName === "INPUT" || e.target.tagName === "TEXTAREA") return;
  if (e.code === "Space" && onCall) { e.preventDefault(); userPaused ? resumeBuddy() : pauseBuddy(); }
  // 0 is the assistant; 1–9 give that agent the floor
  if (!onCall || !/^[0-9]$/.test(e.key)) return;
  const n = Number(e.key);
  focusOn(n === 0 ? centralId : team()[n - 1]?.id);
});

// Closing the tab must never be held up: stop speaking, release the mic, and hang up first.
let closing = false;
addEventListener("pagehide", () => {
  closing = true;
  try { speechSynthesis.cancel(); } catch {}
  try { listener?.destroy?.(); } catch {}
  try { ws?.close(); } catch {}
});

connect();
render();

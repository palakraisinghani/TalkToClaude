import { Voice } from "./voice.js";
import { Earcons } from "./earcon.js";
import { Central } from "./central.js";
import { createVadListener, createChromeListener } from "./listen.js";
import { esc, renderMarkdown } from "./markdown.js";
import { route, soundsLike, LOCAL, calledBy, confusable, spokenName } from "./route.js";
import { isNoise, MIN_VOICED_MS } from "./noise.js";
import { StereoEngine } from "./stereo.js";
import { DEFAULT_MODEL, MODELS, modelChoices, modelLabel } from "./models.js";
import { controlOf, EFFORTS, MODES, modeName, SLASH_HELP, slashOf } from "./controls.js";
import { initDeck } from "./deck.js";
import { drawDiagrams } from "./diagram.js";
import { rateName, suggestNames } from "./namecheck.js";
import * as attention from "./attention.js";
import { icon, setIcon } from "./icons.js";
import { avatar } from "./avatar.js";

// The call has three levels. You lead it. Ada is your assistant: she moves you between the team,
// sets projects up, and keeps track of who needs you. The team are the project agents, each its
// own Claude session; you talk to one of them at a time, and the rest work in the background.

const $ = (id) => document.getElementById(id);
const callEl = $("call"), orb = $("orb"), feed = $("feed");
for (const el of document.querySelectorAll("[data-icon]")) setIcon(el, el.dataset.icon, Number(el.dataset.size) || undefined);
/** Swap an icon only when it changes: draw() runs every frame. */
const showIcon = (el, name, size) => { if (el.dataset.ic !== name) { el.dataset.ic = name; setIcon(el, name, size); } };
showIcon($("callBtn"), "phone", 26);
showIcon($("muteBtn"), "mic");
showIcon($("pauseBtn"), "pause");

// ---------- state ----------
let ws = null;
let onCall = false, muted = false;
let listener = null;
// Every agent on the call, as the server reports it: the assistant first, then the team.
let projects = [];
let focusedId = null;
// Who has the floor as the server last said, and a switch asked for here that it has not confirmed
// yet. The page moves at once — the circle, and where your next words go — instead of waiting for
// the server's word; until then, an older roster still in flight cannot move it back.
let confirmedFocus = null, wantFocus = null, wantAt = 0;
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
const dropped = new Set(); // `${agent}:${turn}` replaced by a merged one; late output is ignored. Turn numbers are per agent
// What the team is waiting on you for: permissions, questions, and news. Nothing here is read
// out uninvited; the attention rules decide when to mention it and when to read it.
let queue = []; // { uid, project, name, kind, text, detail, requestId, questionId, at, onLine }
let queueSeq = 0;
let att = attention.createAttention();
let quietHandover = null; // a focus change the assistant has already spoken for
// An agent just put through says hello itself (server: introduce): the assistant does not
// announce it, and what it is waiting on you for is asked once its hello is done.
let intro = null; // { project, turn }
let talkingId = null; // whose voice is coming out right now
let drawnFocus = null; // who the stage last showed, so a change of floor can be animated
let cameFrom = null; // the agent you left to talk to the assistant, so "back" can return you
let fromTimer = 0;
const activity = new Map(); // agent id -> { text, live } — for the screen; may be clipped
const unread = new Map(); // agent id -> its latest news not yet seen (finished, failed): a dot on its card
const lastSaid = new Map(); // agent id -> its last whole spoken sentence — safe to say aloud
const heardAt = new Map(); // agent id -> when the lead last heard its report, so it is not repeated
let lastNews = null; // the news item read out most recently, kept whole for "tell me more"
const pipeline = new Map(); // new agent id -> { step, at }: seated, briefed, working, reported
const STEPS = ["seated", "briefed", "working", "reported"];
let filter = "all";
const mode = () => ($("audioOnly").checked ? "audio" : "visual");
const project = (id) => projects.find((p) => p.id === id) ?? null;
const focused = () => project(focusedId);
const team = () => projects.filter((p) => !p.central);
const identityOf = (id) => project(id)?.identity ?? (id === centralId ? centralIdentity : null);
const nameOf = (id) => project(id)?.name ?? (id === centralId ? centralName : id ?? "");
/** An agent's illustrated face, for any of the round avatar spots. */
const face = (id) => avatar(nameOf(id) || id || "", identityOf(id)?.hue ?? 18, { central: id === centralId });
/** Put a face in an element, redrawing only when whose face it is changes. */
const showFace = (el, id) => { const k = `${id}|${nameOf(id)}|${identityOf(id)?.hue}`; if (el.dataset.face !== k) { el.dataset.face = k; el.innerHTML = face(id); } };
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
  // who: the one your words go to, and the one whose voice you hear, which can differ (the
  // assistant reading out news while Juno has the floor)
  const floorName = (focusedId && focusedId !== centralId ? project(focusedId)?.name : null) ?? centralName;
  $("stateLabel").textContent = { hearing: `${floorName} is hearing you`, speaking: `${talkingId ? nameOf(talkingId) : floorName} is speaking`, thinking: `${floorName} is working`, listening: `${floorName} is listening`, paused: "paused", asleep: "asleep", muted: "muted" }[s];
  document.body.classList.toggle("is-paused", userPaused);
  document.body.classList.toggle("oncall", onCall);
  showIcon($("pauseBtn"), userPaused ? "play" : "pause");
  setHTML($("feedState"), working ? '<span class="spin"></span> working' : "");
  const f = focused();
  const name = f?.name ?? centralName;
  callEl.style.setProperty("--hue", String(f?.identity?.hue ?? centralIdentity?.hue ?? 18));
  $("onLine").textContent = name;
  $("onLineRole").textContent = !f || f.central ? "your assistant" : tilde(f.dir);
  drawFloorControls(f ?? project(centralId));
  showFace(orb, focusedId ?? centralId);
  const shown = focusedId ?? centralId;
  if (onCall && drawnFocus && drawnFocus !== shown) showSwitch(drawnFocus);
  drawnFocus = onCall ? shown : null;
  // another voice on this floor — the assistant handing over, or answering for the page
  const guest = onCall && voice.speaking && talkingId && talkingId !== shown ? talkingId : null;
  $("guest").classList.toggle("on", !!guest);
  if (guest) {
    showFace($("guest"), guest);
    $("guest").title = `${nameOf(guest)} is speaking`;
    $("guest").style.setProperty("--guest-hue", String(identityOf(guest)?.hue ?? 18));
  }
  // with the assistant, a way straight back to whoever you left
  const back = onCall && shown === centralId && cameFrom && project(cameFrom) ? project(cameFrom) : null;
  $("backBtn").hidden = !back;
  if (back) {
    setHTML($("backBtn"), `${icon("back", 15)}Back to ${esc(back.name)}`);
    $("backBtn").style.setProperty("--back-hue", String(back.identity?.hue ?? 18));
  }
  const waiting = queue.length;
  document.body.classList.toggle("has-notices", waiting > 0 && onCall);
  $("nbadge").textContent = String(waiting);
  $("teamBadge").textContent = waiting && onCall ? String(waiting) : "";
  for (const id of ["standupBtn", "newBtn", "holdBtn"]) $(id).disabled = !onCall;
  $("holdBtn").textContent = att.hold ? "Take calls" : "Hold calls";
  drawHead();
  drawTray();
  drawTable();
  drawFilters();
  drawCanvas();
  if ($("settingsDlg").open) drawModels();
}

/** The floor moved: turn the orb over, slide the name in, and say for a moment who it came from. */
function showSwitch(from) {
  for (const [el, cls] of [[orb, "swap"], [$("onLineWho"), "swap"]]) {
    el.classList.remove(cls);
    void el.offsetWidth; // restart the animation if one is still running
    el.classList.add(cls);
  }
  const tag = $("fromTag");
  tag.textContent = `from ${nameOf(from)}`;
  tag.style.setProperty("--from-hue", String(identityOf(from)?.hue ?? 18));
  tag.classList.remove("fade");
  clearTimeout(fromTimer);
  fromTimer = setTimeout(() => { tag.classList.add("fade"); fromTimer = setTimeout(() => (tag.textContent = ""), 700); }, 3500);
}
orb.addEventListener("animationend", () => orb.classList.remove("swap"));
$("onLineWho").addEventListener("animationend", () => $("onLineWho").classList.remove("swap"));
$("backBtn").onclick = () => cameFrom && focusOn(cameFrom);

function drawHead() {
  const c = projects.find((p) => p.central) ?? { id: centralId, name: centralName, central: true, identity: centralIdentity ?? { hue: 18 } };
  let el = $("headCard").firstElementChild;
  if (!el) {
    el = document.createElement("div");
    el.className = "headcard";
    el.innerHTML = `<span class="av big"></span><div><div class="role">your assistant</div><div class="nm"></div><div class="sub"></div><div class="hfoot"><div class="listening"><i></i><i></i><i></i><i></i></div></div></div><div class="htools"></div>`;
    el.querySelector(".hfoot").appendChild(modelPicker(centralId));
    // rename her, or teach how you say her name, like any agent
    for (const [name, title, fn] of [["mic", "Teach how you say her name", () => openTeach(centralId)], ["pencil", "Rename your assistant", () => renameAgent(centralId)]]) {
      const b = Object.assign(document.createElement("button"), { className: "iconbtn", title, innerHTML: icon(name, 14) });
      b.onclick = (e) => { e.stopPropagation(); fn(); };
      el.querySelector(".htools").appendChild(b);
    }
    el.onclick = () => focusOn(centralId);
    $("headCard").appendChild(el);
  }
  el.style.setProperty("--hue", String(c.identity?.hue ?? 18));
  el.classList.toggle("on", focusedId === centralId);
  showFace(el.querySelector(".av"), c.id);
  syncPicker(el.querySelector("select.model"), c.model, c.running);
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
    const kind = { permission: "needs a yes", question: "has a question", blocked: "was stopped", failed: "hit a problem", finished: "finished", long: "taking a while" }[item.kind] ?? item.kind;
    el.innerHTML = `<div class="hh"><span class="av mini">${face(item.project)}</span><b>${esc(item.name)}</b><span class="kind">${kind}</span><span class="age"></span></div><div class="what"></div>`;
    el.querySelector(".what").textContent = item.text.replace(new RegExp(`^${item.name}( asks:)? `), "");
    const [cmd, ...why] = String(item.detail ?? "").split("\n");
    if (item.kind === "permission" && cmd) el.appendChild(Object.assign(document.createElement("pre"), { textContent: cmd }));
    if (item.kind === "permission" && why.join(" ").trim()) el.appendChild(Object.assign(document.createElement("div"), { className: "why", textContent: why.join(" ") }));
    const acts = Object.assign(document.createElement("div"), { className: "acts" });
    const btn = (label, cls, fn) => { const b = Object.assign(document.createElement("button"), { textContent: label, className: cls }); b.onclick = (e) => { e.stopPropagation(); fn(); }; acts.appendChild(b); };
    if (item.kind === "permission" && item.risk) {
      // cannot be undone: said in red, allowed only by a second, deliberate press, never "always"
      el.classList.add("risky");
      el.appendChild(Object.assign(document.createElement("div"), { className: "risk", textContent: `Can't be undone: ${item.risk}.` }));
      let armed = false;
      btn("Allow…", "yes", function () {
        const b = acts.querySelector("button.yes");
        if (!armed) { armed = true; b.textContent = "Confirm allow"; b.classList.add("armed"); setTimeout(() => { armed = false; b.textContent = "Allow…"; b.classList.remove("armed"); }, 6000); return; }
        answerItem(item, { type: "grant", scope: "once" });
      });
      btn("Deny", "no", () => answerItem(item, { type: "deny" }));
    } else if (item.kind === "permission") {
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
    el.innerHTML = `<span class="handup" title="Waiting for you">${icon("bell", 12)}</span><div class="tools"></div><div class="top"><span class="av"></span><div><div class="nm"></div><div class="st"></div></div></div><div class="doing"></div><div class="stepwrap"></div><div class="foot"><div class="meta"></div></div>`;
    const tools = el.querySelector(".tools");
    const tool = (name, title, fn) => { const b = Object.assign(document.createElement("button"), { className: "iconbtn", title, innerHTML: icon(name, 15) }); b.onclick = (e) => { e.stopPropagation(); fn(); }; tools.appendChild(b); };
    tool("mic", "Teach how you say its name", () => openTeach(p.id));
    tool("back", "Undo its last piece of work", () => askUndo(p.id));
    tool("pencil", "Rename", () => renameAgent(p.id));
    tool("park", "Park: stop this agent, keep its conversation", () => send({ type: "park", project: p.id }));
    tool("x", "Take off the team (the folder is kept)", async () => { if (await askSure(`Take ${p.name} off the team? Its folder and conversation stay on disk.`, "Take off the team")) send({ type: "remove", project: p.id }); });
    el.querySelector(".foot").appendChild(modelPicker(p.id));
    el.onclick = () => focusOn(p.id);
    el.onkeydown = (e) => { if (e.key === "Enter") focusOn(p.id); };
    seatEls.set(p.id, el);
  }
  const waitingItem = queue.find((i) => i.project === p.id && (i.kind === "permission" || i.kind === "question"));
  el.classList.toggle("on", p.id === focusedId);
  el.classList.toggle("talking", p.id === talkingId);
  el.classList.toggle("raised", !!waitingItem);
  // news it has that the lead has not seen yet: a dot, not an interruption
  const news = p.id !== focusedId ? unread.get(p.id) : null;
  el.classList.toggle("has-news", !!news);
  el.dataset.news = news ? (news.kind === "failed" ? "problem" : "new") : "";
  el.dataset.state = p.state;
  el.style.setProperty("--hue", String(p.identity?.hue ?? 0));
  showFace(el.querySelector(".av"), p.id);
  el.querySelector(".nm").textContent = p.name;
  el.querySelector(".st").textContent = (p.mode && p.mode !== "auto" ? `${modeName(p.mode).toLowerCase()} · ` : "") + (p.id === focusedId ? "talking with you" : waitingItem ? (waitingItem.kind === "question" ? "has a question for you" : "needs your yes") : { working: "working", warm: "free", cold: "not started", parked: "parked", blocked: "waiting" }[p.state] ?? p.state);
  const a = activity.get(p.id);
  const doing = el.querySelector(".doing");
  doing.textContent = a?.text || p.question || p.report || (p.state === "cold" ? "Ready when you are." : "");
  doing.classList.toggle("live", !!a?.live && p.state === "working");
  const pipe = pipeline.get(p.id);
  const wrap = el.querySelector(".stepwrap");
  if (pipe && (pipe.step < 3 || Date.now() - pipe.at < 20_000)) {
    setHTML(wrap, `<div class="steps">${STEPS.map((_, i) => `<span class="${i < pipe.step ? "done" : i === pipe.step ? (pipe.step === 3 ? "done" : "now") : ""}"></span>`).join("")}</div><div class="steplabel">${STEPS[pipe.step]}</div>`);
  } else setHTML(wrap, "");
  // what it has cost and how long it has worked this call, as the CLI reports it
  const meter = [p.busyMs ? `${Math.max(1, Math.round(p.busyMs / 60000))}m work` : "", p.costUsd ? `$${p.costUsd < 0.1 ? p.costUsd.toFixed(3) : p.costUsd.toFixed(2)}` : ""].filter(Boolean).join(", ");
  el.querySelector(".meta").textContent = [tilde(p.dir), voiceConfident.has(p.id) ? "knows your voice" : voiceCounts[p.id] ? "partly learned" : "", p.turns ? `${p.turns} turn${p.turns > 1 ? "s" : ""}` : "", meter].filter(Boolean).join(" · ");
  syncPicker(el.querySelector("select.model"), p.model, p.running);
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
    addSeat.innerHTML = `<span class="plus">${icon("plus", 16)}</span><span>New agent<br><span style="font-size:11px">or ask ${esc(centralName)}</span></span>`;
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

// ---------- canvas: what the agents put up for you to see ----------
// Plans, pictures, charts and explanations: every <screen> an agent writes, every picture it
// looks at, its to-do list, and plans or questions waiting on you. Newest first. By default it
// follows the floor, showing whoever you are talking to; the chips pick someone else, or all.
const MAX_ARTS = 80;
const arts = []; // newest first: { el, pid, key, body, ttl }
const artByKey = new Map();
const plans = new Map(); // agent id -> its latest to-do list, [{ text, status }]
const unseen = new Map(); // agent id -> things put up while you were looking elsewhere
let canvasPick = null; // the agent chosen when not following the floor; null is everyone
let artSeq = 0;
const canvasPid = () => ($("followFloor").checked ? focusedId ?? centralId : canvasPick);
const onCanvas = (pid) => { const c = canvasPid(); return c === null || c === pid; };

function artifact(pid, key, { kind = "", title = "" } = {}) {
  let a = artByKey.get(key);
  if (a) return a;
  const el = document.createElement("article");
  el.className = "art";
  el.id = `art-${++artSeq}`;
  el.dataset.pid = pid;
  el.style.setProperty("--hue", String(identityOf(pid)?.hue ?? 18));
  const at = new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  el.innerHTML = `<header><span class="av mini">${face(pid)}</span><span class="ttl"></span>${kind ? `<span class="kind">${esc(kind)}</span>` : ""}<span>${at}</span><button class="artcopy iconbtn" title="Copy the text">${icon("copy", 14)}</button></header><div class="body"></div>`;
  a = { el, pid, key, body: el.querySelector(".body"), ttl: el.querySelector(".ttl") };
  a.ttl.textContent = title || `From ${nameOf(pid)}`;
  $("canvas").prepend(el);
  arts.unshift(a);
  artByKey.set(key, a);
  while (arts.length > MAX_ARTS) { const old = arts.pop(); old.el.remove(); artByKey.delete(old.key); }
  if (!onCanvas(pid)) unseen.set(pid, (unseen.get(pid) ?? 0) + 1);
  markFresh("canvas", { expand: true }); // a picture, diagram or explanation: worth seeing
  render();
  return a;
}

/** A chip in the feed pointing at what went up on the canvas. */
function canvasChip(pid, turn, a, label) {
  const c = card(pid, turn);
  const n = Object.assign(document.createElement("button"), { className: "oncanvas" });
  n.innerHTML = `${icon("canvas", 13)}<span></span>`;
  n.lastChild.textContent = label;
  n.onclick = () => showArt(a);
  c.el.appendChild(n);
  c.last = { kind: "chip", node: n };
  scrollFeed();
  return n;
}

/** Bring an item into view on the canvas: switch to its agent if needed, and flash it. */
function showArt(a) {
  if (!onCanvas(a.pid)) { $("followFloor").checked = false; canvasPick = a.pid; }
  showPane("canvas");
  drawCanvas();
  a.el.scrollIntoView({ behavior: "smooth", block: "start" });
  a.el.classList.add("flash");
  setTimeout(() => a.el.classList.remove("flash"), 1200);
}

/**
 * An agent's questions for you, as a form on the canvas: each question with its choices as chips
 * and a box for your answer, and one button that sends them all back to that agent. They are
 * said out loud too; answering by voice works just as well.
 */
function showQuestions(m) {
  const a = artifact(m.project, m.id, { kind: "questions", title: `${nameOf(m.project)} asks` });
  const form = Object.assign(document.createElement("form"), { className: "qform", autocomplete: "off" });
  m.items.forEach((it, i) => {
    const row = Object.assign(document.createElement("div"), { className: "qrow" });
    const label = Object.assign(document.createElement("label"), { htmlFor: `${m.id}-${i}`, textContent: it.q });
    const input = Object.assign(document.createElement("input"), { id: `${m.id}-${i}`, name: `a${i}`, placeholder: it.options.length ? "Pick one, or type your own" : "Your answer" });
    row.append(label);
    if (it.options.length) {
      const chips = Object.assign(document.createElement("div"), { className: "qchips" });
      for (const opt of it.options) {
        const chip = Object.assign(document.createElement("button"), { type: "button", className: "qchip", textContent: opt });
        chip.onclick = () => { input.value = opt; for (const c of chips.children) c.classList.toggle("on", c === chip); };
        chips.append(chip);
      }
      input.oninput = () => { for (const c of chips.children) c.classList.toggle("on", c.textContent === input.value); };
      row.append(chips);
    }
    row.append(input);
    form.append(row);
  });
  const foot = Object.assign(document.createElement("div"), { className: "qfoot" });
  const send = Object.assign(document.createElement("button"), { type: "submit", className: "qsend", textContent: "Send answers" });
  const note = Object.assign(document.createElement("span"), { className: "qnote" });
  foot.append(send, note);
  form.append(foot);
  form.onsubmit = (e) => {
    e.preventDefault();
    const answers = m.items.map((it, i) => ({ q: it.q, a: form.elements[`a${i}`].value.trim() }));
    if (answers.every((x) => !x.a)) { note.textContent = "Answer at least one first."; return; }
    const text = `My answers:\n${answers.map((x, i) => `${i + 1}. ${x.q} — ${x.a || "no preference"}`).join("\n")}`;
    inputTyped = true;
    ask(text, text, { project: m.project });
    for (const el of form.elements) el.disabled = true;
    form.classList.add("sent");
    note.textContent = `Sent to ${nameOf(m.project)}.`;
  };
  a.body.replaceChildren(form);
  form.querySelector("input")?.focus({ preventScroll: true });
}

/** The latest to-do list an agent wrote, as a checklist with progress. */
function updatePlan(pid, detail) {
  const items = detail.split("\n").map((l) => /^\[(x|~| )\] (.*)$/.exec(l)).filter(Boolean)
    .map((m) => ({ text: m[2], status: m[1] === "x" ? "done" : m[1] === "~" ? "now" : "todo" }));
  if (!items.length) return;
  plans.set(pid, items);
  if (!onCanvas(pid)) unseen.set(pid, (unseen.get(pid) ?? 0) + 1);
  markFresh("canvas");
  render();
}

let planDrawn = "";
function drawCanvas() {
  const pid = canvasPid();
  let shown = 0;
  for (const a of arts) {
    const hide = pid !== null && a.pid !== pid;
    if (a.el.hidden !== hide) a.el.hidden = hide;
    if (!hide) shown++;
  }
  // the plan of whoever is shown; with everyone shown, of whoever has the floor
  const planPid = pid ?? focusedId ?? centralId;
  const plan = plans.get(planPid);
  const sig = plan ? `${planPid}|${JSON.stringify(plan)}` : "";
  if (sig !== planDrawn) {
    planDrawn = sig;
    const el = $("canvasPlan");
    if (!plan) el.innerHTML = "";
    else {
      const done = plan.filter((i) => i.status === "done").length;
      el.innerHTML = `<div class="checklist" style="--hue:${identityOf(planPid)?.hue ?? 18}"><div class="ph"><span class="av mini">${face(planPid)}</span>${esc(nameOf(planPid))}'s plan<small>${done} of ${plan.length} done</small></div><div class="bar"><i style="width:${(100 * done) / plan.length}%"></i></div><ul>${plan.map((i) => `<li class="${i.status}"><span class="box">${i.status === "done" ? icon("check", 11) : ""}</span><span>${esc(i.text)}</span></li>`).join("")}</ul></div>`;
    }
  }
  $("canvasEmpty").hidden = shown > 0 || !!plan;
  if (pid !== null) unseen.delete(pid);
  if (pid === null) unseen.clear();
  // chips: everyone, then each agent that has put something up
  const ids = projects.map((p) => p.id).filter((id) => arts.some((a) => a.pid === id) || plans.has(id));
  const bar = $("canvasFilters");
  const want = ["all", ...ids].join(",");
  if (bar.dataset.ids !== want) {
    bar.dataset.ids = want;
    bar.innerHTML = "";
    for (const id of ["all", ...ids]) {
      const b = document.createElement("button");
      b.dataset.id = id;
      if (id === "all") b.textContent = "Everyone";
      else { b.style.setProperty("--hue", String(identityOf(id)?.hue ?? 0)); b.innerHTML = `<span class="dot"></span>${esc(nameOf(id))}<span class="n" hidden></span>`; }
      b.onclick = () => { $("followFloor").checked = false; canvasPick = id === "all" ? null : id; drawCanvas(); };
      bar.appendChild(b);
    }
  }
  bar.hidden = !ids.length;
  for (const b of bar.children) {
    b.classList.toggle("on", b.dataset.id === (pid ?? "all"));
    const n = b.querySelector(".n");
    if (n) { const k = unseen.get(b.dataset.id) ?? 0; n.hidden = !k; n.textContent = String(k); }
  }
}
$("followFloor").onchange = () => { if (!$("followFloor").checked) canvasPick = focusedId ?? centralId; drawCanvas(); };

// ---------- phone: one section at a time, chosen from the tab bar ----------
// a phone, a tablet held upright, a small window, or anything short: kept in step with index.html
const phone = matchMedia("(max-width: 900px), (max-height: 520px)");
let tab = "call";
function setTab(which) {
  tab = which;
  for (const t of ["call", "team", "canvas", "feed"]) document.body.classList.toggle(`tab-${t}`, t === which);
  for (const b of document.querySelectorAll("#phoneNav button")) {
    b.classList.toggle("on", b.dataset.tab === which);
    if (b.dataset.tab === which) b.classList.remove("fresh");
  }
}
setTab("call");
for (const b of document.querySelectorAll("#phoneNav button")) b.onclick = () => setTab(b.dataset.tab);

/** The canvas's usable size, "640x820", for the agents to draw diagrams to fit; "" when hidden. */
function canvasSize() {
  const el = $("canvasScroll");
  const w = el?.clientWidth ?? 0, h = el?.clientHeight ?? 0;
  return w > 50 && h > 50 ? `${Math.round(w - 24)}x${Math.round(h)}` : "";
}

// ---------- wide screens: the sections as a deck to resize, collapse and rearrange ----------
const deck = initDeck({
  main: document.querySelector("main"),
  sections: { head: $("head"), room: $("room"), canvas: $("canvasWrap"), feed: $("feedWrap") },
  labels: { head: "Team", room: "Call", canvas: "Canvas", feed: "Behind the scenes" },
  enabled: () => innerWidth >= 1100 && !phone.matches,
});

// ---------- canvas and behind the scenes as tabs, on screens too narrow for both ----------
const narrow = matchMedia("(max-width: 1500px)");
function showPane(which) {
  if (phone.matches) setTab(which === "feed" ? "feed" : "canvas");
  document.body.classList.toggle("show-feed", which === "feed");
  for (const b of document.querySelectorAll(".tabs button")) {
    b.classList.toggle("on", b.dataset.pane === which);
    if (b.dataset.pane === which) b.classList.remove("fresh");
  }
}
/** A dot on a tab that has something new while you look at the other one. */
function markFresh(which, { expand = false } = {}) {
  // wide screens: a collapsed section shows a dot, and the canvas opens itself for a new picture
  if (deck.active()) {
    if (expand) deck.expand(which);
    deck.fresh(which);
    return;
  }
  if (phone.matches) {
    if (tab !== which) document.querySelector(`#phoneNav button[data-tab="${which}"]`)?.classList.add("fresh");
    return;
  }
  // folded to its rail on a wide screen: the rail's dot says something new is in there
  if (which === "feed" && !narrow.matches && (document.body.classList.contains("feed-folded") || document.body.classList.contains("canvas-wide"))) $("feedRail").classList.add("fresh");
  if (!narrow.matches) return;
  const showing = document.body.classList.contains("show-feed") ? "feed" : "canvas";
  if (showing === which) return;
  for (const b of document.querySelectorAll(`.tabs button[data-pane="${which}"]`)) b.classList.add("fresh");
}
for (const b of document.querySelectorAll(".tabs button")) b.onclick = () => showPane(b.dataset.pane);

// ---------- models: each agent its own ----------
// ---------- Claude Code's controls: mode, effort, new conversation, compact ----------
// The same from a button, a typed /command, the voice ("plan mode", "Juno, think harder") or
// Ada's <control> tag; the server answers with what was done, said in the assistant's voice.
function runControl(pid, what, value = "") {
  if (!pid) return;
  if (!send({ type: "control", project: pid, what, value })) feedNote("Not connected.", pid, true);
}
function controlDone(m) {
  feedNote(m.said, m.project, !m.ok);
  if (onCall) central.say(m.said);
}
const fillSelect = (sel, list) => (sel.innerHTML = list.map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join(""));
fillSelect($("ctlMode"), MODES);
fillSelect($("ctlEffort"), EFFORTS);
const floorId = () => focusedId ?? centralId;
$("ctlMode").onchange = () => runControl(floorId(), "mode", $("ctlMode").value);
$("ctlEffort").onchange = () => runControl(floorId(), "effort", $("ctlEffort").value || "default");
$("ctlModel").onchange = () => setModel(floorId(), $("ctlModel").value);
$("ctlMore").onclick = (e) => { e.stopPropagation(); $("ctlMenu").hidden = !$("ctlMenu").hidden; };
document.addEventListener("click", (e) => { if (!$("floorCtl").contains(e.target)) $("ctlMenu").hidden = true; });
for (const b of $("ctlMenu").querySelectorAll("button")) b.onclick = () => { $("ctlMenu").hidden = true; menuControl(b.dataset.ctl); };
function menuControl(what) {
  const pid = floorId();
  if (what === "undo") return askUndo(pid === centralId ? null : pid);
  if (what === "stop") { send({ type: "interrupt", project: pid }); if (onCall) central.say(`Stopped ${nameOf(pid)}.`); return; }
  if (what === "help") return showSlashHelp("/");
  if (what === "clear") {
    askSure(`Start a new conversation with ${nameOf(pid)}? It forgets this one (its files stay).`, "New conversation").then((ok) => ok && runControl(pid, what));
    return;
  }
  runControl(pid, what);
}
function drawFloorControls(f) {
  if (!f) return;
  const keep = (sel, v) => { if (document.activeElement !== sel && sel.value !== v) sel.value = v; };
  keep($("ctlMode"), f.mode ?? "auto");
  $("ctlMode").dataset.mode = f.mode ?? "auto";
  keep($("ctlEffort"), f.effort ?? "");
  syncPicker($("ctlModel"), f.model, f.running);
}
fillModels($("ctlModel"));

// typed commands, Claude Code style: a list as you type "/", run on Enter
function showSlashHelp(prefix = "/", error = "") {
  const box = $("slashHelp");
  const rows = SLASH_HELP.filter(([c]) => c.startsWith(prefix.split(" ")[0]) || prefix === "/");
  box.innerHTML = (error ? `<div class="err">${esc(error)}</div>` : "") + rows.map(([c, d]) => `<div class="row" data-cmd="${esc(c.split(" ")[0])}"><code>${esc(c)}</code><span>${esc(d)}</span></div>`).join("");
  box.hidden = !rows.length && !error;
  for (const r of box.querySelectorAll(".row")) r.onclick = () => { $("typeBox").value = r.dataset.cmd + (/[<|]/.test(r.textContent) ? " " : ""); $("typeBox").focus(); showSlashHelp($("typeBox").value); };
}
function runSlash(line) {
  const c = slashOf(line);
  if (!c) return false;
  const pid = floorId();
  $("slashHelp").hidden = true;
  if (c.error) { showSlashHelp("/", c.error); return true; }
  if (c.what) runControl(pid, c.what, c.value ?? "");
  else if (c.action === "model") setModel(pid, MODELS.find((m) => m.alias === c.value || m.id === c.value)?.alias ?? c.value);
  else if (c.action === "undo") askUndo(pid === centralId ? null : pid);
  else if (c.action === "stop") { send({ type: "interrupt", project: pid }); feedNote(`Stopped ${nameOf(pid)}.`, pid); }
  else if (c.action === "btw") send({ type: "btw", project: pid, text: c.value });
  else if (c.action === "help") showSlashHelp("/");
  return true;
}
$("typeBox").addEventListener("input", () => {
  const v = $("typeBox").value;
  if (v.startsWith("/")) showSlashHelp(v); else $("slashHelp").hidden = true;
});

// full names and ids, with the default's model in brackets (web/models.js)
function fillModels(sel, current = "") {
  sel.innerHTML = modelChoices(current).map(([v, l]) => `<option value="${esc(v)}">${esc(l)}</option>`).join("");
  sel.value = current;
}
function modelPicker(pid) {
  const sel = Object.assign(document.createElement("select"), { className: "model", title: "The Claude model this agent runs on" });
  fillModels(sel);
  // a choice here is not a click on the seat
  sel.onclick = (e) => e.stopPropagation();
  sel.onkeydown = (e) => e.stopPropagation();
  sel.onchange = () => setModel(pid, sel.value);
  return sel;
}
function syncPicker(sel, model = "", running = "") {
  if (!sel) return;
  // what Claude Code says it is really running, which a provider may name more precisely
  sel.title = running ? `Running ${running}` : `Will run ${modelLabel(model || DEFAULT_MODEL)}`;
  if (document.activeElement === sel) return;
  if (![...sel.options].some((o) => o.value === model)) fillModels(sel, model);
  if (sel.value !== model) sel.value = model;
}
function setModel(pid, model) {
  send({ type: "set-model", project: pid, model });
  feedNote(`${nameOf(pid)} will use ${modelLabel(model || DEFAULT_MODEL)} from its next turn.`, pid);
}
const modelRows = new Map();
function drawModels() {
  const list = $("modelList");
  if (!projects.length) return;
  list.querySelector(".empty")?.remove();
  for (const [id, row] of modelRows) if (!projects.some((p) => p.id === id)) { row.remove(); modelRows.delete(id); }
  projects.forEach((p, i) => {
    let row = modelRows.get(p.id);
    if (!row) {
      row = Object.assign(document.createElement("div"), { className: "modelrow" });
      row.style.setProperty("--hue", String(p.identity?.hue ?? 18));
      row.innerHTML = `<span class="av mini">${face(p.id)}</span><b>${esc(p.name)}<small class="role"></small></b>`;
      row.appendChild(modelPicker(p.id));
      const modeSel = Object.assign(document.createElement("select"), { className: "pick mode", title: "Mode" });
      fillSelect(modeSel, MODES);
      modeSel.onchange = () => runControl(p.id, "mode", modeSel.value);
      const effortSel = Object.assign(document.createElement("select"), { className: "pick effort", title: "Effort" });
      fillSelect(effortSel, EFFORTS);
      effortSel.onchange = () => runControl(p.id, "effort", effortSel.value || "default");
      row.append(modeSel, effortSel);
      modelRows.set(p.id, row);
    }
    if (list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null);
    syncPicker(row.querySelector("select.model"), p.model, p.running);
    for (const [cls, v] of [["mode", p.mode ?? "auto"], ["effort", p.effort ?? ""]]) {
      const sel = row.querySelector(`select.${cls}`);
      if (sel && document.activeElement !== sel && sel.value !== v) sel.value = v;
    }
    row.querySelector(".role").textContent = [p.central ? "assistant" : "", p.running ? `running ${p.running}` : ""].filter(Boolean).join(" · ");
  });
}

// How each agent sounds: its voice, speed, volume and side. Changed here, by the assistant, or by
// the agent itself; kept on the server with the roster, so every page and every call agrees.
const voiceRows = new Map();
function englishVoices() {
  const vs = (speechSynthesis.getVoices?.() ?? []).filter((v) => /^en[-_]/i.test(v.lang));
  return [...new Map(vs.map((v) => [v.name.replace(/\s*\(.*$/, ""), v])).keys()].sort();
}
function drawVoices() {
  const list = $("voiceList");
  if (!projects.length) return;
  list.querySelector(".empty")?.remove();
  for (const [id, row] of voiceRows) if (!projects.some((p) => p.id === id)) { row.remove(); voiceRows.delete(id); }
  const names = englishVoices();
  projects.forEach((p, i) => {
    let row = voiceRows.get(p.id);
    const id = p.identity ?? {};
    if (!row) {
      row = Object.assign(document.createElement("div"), { className: "voicerow" });
      row.style.setProperty("--hue", String(id.hue ?? 18));
      row.innerHTML = `<span class="av mini">${face(p.id)}</span><b>${esc(p.name)}</b>
        <div class="vctl"><label>Voice <select data-k="voice"></select></label><button class="play" type="button" title="Hear it">▶ Hear</button></div>
        <div class="vctl"><label>Speed <input type="range" data-k="rate" min="0.7" max="1.5" step="0.05"></label><span data-show="rate"></span></div>
        <div class="vctl"><label>Volume <input type="range" data-k="volume" min="0.1" max="1" step="0.05"></label><span data-show="volume"></span></div>
        <div class="vctl"><label>Side <select data-k="pan"><option value="-0.7">Left</option><option value="-0.35">Slightly left</option><option value="0">Centre</option><option value="0.35">Slightly right</option><option value="0.7">Right</option></select></label></div>`;
      const sendSound = (k, v) => send({ type: "set-sound", project: p.id, [k]: v });
      row.querySelector("[data-k=voice]").onchange = (e) => sendSound("voice", e.target.value);
      for (const k of ["rate", "volume"]) {
        const input = row.querySelector(`[data-k=${k}]`);
        input.oninput = () => { row.querySelector(`[data-show=${k}]`).textContent = k === "rate" ? `${(+input.value).toFixed(2)}×` : `${Math.round(input.value * 100)}%`; };
        input.onchange = () => sendSound(k, +input.value);
      }
      row.querySelector("[data-k=pan]").onchange = (e) => sendSound("pan", +e.target.value);
      row.querySelector(".play").onclick = () => voice.say(`Hi, I'm ${project(p.id)?.name ?? p.name}. This is how I sound.`, 0, { record: false, keep: true, identity: project(p.id)?.identity, speaker: p.id });
      voiceRows.set(p.id, row);
    }
    if (list.children[i] !== row) list.insertBefore(row, list.children[i] ?? null);
    // reflect what the server has now, without stealing a control the lead is dragging
    const sel = row.querySelector("[data-k=voice]");
    const current = (id.voices ?? [])[0] ?? "";
    const opts = [...new Set([current, ...names].filter(Boolean))];
    if (sel.dataset.opts !== opts.join("|")) { sel.innerHTML = opts.map((n) => `<option>${esc(n)}</option>`).join(""); sel.dataset.opts = opts.join("|"); }
    if (document.activeElement !== sel) sel.value = current;
    for (const [k, v] of [["rate", id.rate ?? 1], ["volume", id.volume ?? 1]]) {
      const input = row.querySelector(`[data-k=${k}]`);
      if (document.activeElement !== input) { input.value = String(v); input.oninput(); }
    }
    const pan = row.querySelector("[data-k=pan]");
    if (document.activeElement !== pan) pan.value = String([-0.7, -0.35, 0, 0.35, 0.7].reduce((a, b) => (Math.abs(b - (id.pan ?? 0)) < Math.abs(a - (id.pan ?? 0)) ? b : a)));
  });
}

// ---------- settings ----------
$("settingsBtn").onclick = () => { drawModels(); drawVoices(); $("settingsDlg").showModal(); };
$("settingsClose").onclick = () => $("settingsDlg").close();
// a click on the dimmed page outside the drawer closes it
$("settingsDlg").addEventListener("click", (e) => { if (e.target === $("settingsDlg")) $("settingsDlg").close(); });
function segment(el, value, onPick) {
  const sync = (v) => { for (const b of el.children) b.classList.toggle("on", b.dataset.v === v); };
  sync(value);
  for (const b of el.children) b.onclick = () => { sync(b.dataset.v); onPick(b.dataset.v); };
  return sync;
}
// light, dark, or whatever the system says; the moon or sun in the top bar flips it at once
let theme = "";
try { theme = localStorage.getItem("theme") || ""; } catch {}
const systemDark = matchMedia("(prefers-color-scheme: dark)");
const isDark = () => theme === "dark" || (!theme && systemDark.matches);
function applyTheme(v) {
  theme = v;
  if (v) document.documentElement.dataset.theme = v; else delete document.documentElement.dataset.theme;
  try { localStorage.setItem("theme", v); } catch {}
  showIcon($("themeBtn"), isDark() ? "sun" : "moon");
  $("themeBtn").title = isDark() ? "Switch to light" : "Switch to dark";
  syncTheme?.(v);
}
let syncTheme = null;
syncTheme = segment($("themeSeg"), theme, applyTheme);
applyTheme(theme);
$("themeBtn").onclick = () => applyTheme(isDark() ? "light" : "dark");
systemDark.addEventListener("change", () => applyTheme(theme));

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
  markFresh("feed");
  // a long call would otherwise keep every tool's full output in the page for ever
  while (feed.childElementCount > FEED_MAX) {
    const old = feed.firstElementChild;
    old.remove();
    if (old.dataset.card) cards.delete(old.dataset.card);
  }
}
const FEED_MAX = 400;

/**
 * Write markup only when it differs from what is there. draw() runs on every frame while anyone
 * talks; rewriting identical markup restarts its animations, so spinners never seemed to spin.
 */
const written = new WeakMap();
function setHTML(el, html) {
  if (!el || written.get(el) === html) return;
  written.set(el, html);
  el.innerHTML = html;
}
function card(pid, turn) {
  const k = key(pid, turn);
  let c = cards.get(k);
  if (c) return c;
  const el = document.createElement("div");
  el.className = "turn";
  const hue = identityOf(pid)?.hue;
  if (hue !== undefined) el.style.setProperty("--hue", String(hue));
  el.innerHTML = `<div class="q"><span class="who">${esc(nameOf(pid) || "ClaudeCall")}</span><span class="qt"></span><span class="st"><span class="spin"></span></span></div>`;
  el.dataset.card = k;
  if (!dropped.has(key(pid, turn))) addToFeed(el, pid);
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
  if (detail) {
    const pre = Object.assign(document.createElement("pre"), { className: "io in" });
    // an edit reads as a diff: removed lines red, added lines green
    if (/^Edit\b/.test(label)) {
      detail.split("\n").forEach((l, i) => pre.appendChild(Object.assign(document.createElement("span"), { className: i && l.startsWith("- ") ? "del" : i && l.startsWith("+ ") ? "add" : "", textContent: l + "\n" })));
    } else pre.textContent = detail;
    n.appendChild(pre);
    // a short edit is worth seeing without a click; a to-do list becomes the plan on the canvas
    if (/^Edit\b/.test(label) && detail.split("\n").length <= 30) n.open = true;
    if (label === "TodoWrite") updatePlan(pid, detail);
  }
  c.el.appendChild(n);
  c.last = { kind: "tool", node: n };
  c.tools.set(id, n);
  scrollFeed();
}
function feedToolResult(pid, turn, id, ok, summary, detail, images) {
  const n = cards.get(key(pid, turn))?.tools.get(id);
  if (!n) return;
  if (images?.length) {
    // a picture the agent looked at goes up on the canvas, named after what it opened
    const what = n.querySelector(".lbl").textContent.replace(/^Read · /, "");
    const a = artifact(pid, `img:${id}`, { kind: "picture", title: what });
    const pics = Object.assign(document.createElement("div"), { className: images.length > 1 ? "pics" : "" });
    // each arrives as a light cached copy with a preview; an older server sent the picture itself
    for (const r of images) {
      const slot = Object.assign(document.createElement("span"), { className: "media" });
      slot.dataset.alt = what;
      slot.dataset.src = typeof r === "string" ? r : r.url;
      fillMedia(slot, typeof r === "string" ? { kind: "image", url: r } : { ...r, kind: "image" });
      pics.appendChild(slot);
    }
    a.body.appendChild(pics);
    const chip = canvasChip(pid, turn, a, `Picture on the canvas: ${what}`);
    n.after(chip);
  }
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
  const a = artifact(pid, `screen:${key(pid, turn)}`);
  if (!c.chip) c.chip = canvasChip(pid, turn, a, "On the canvas");
  c.screenMd += text;
  if (c.screenPending) return;
  c.screenPending = true;
  requestAnimationFrame(() => {
    c.screenPending = false;
    const md = c.screenMd.replace(/^\n+|\s+$/g, "");
    renderInto(a.body, pid, md);
    // its first heading names it, on the canvas and in the feed
    const title = /^\s*#{1,3}\s+(.+)$/m.exec(md)?.[1]?.trim() || `From ${nameOf(pid)}`;
    a.ttl.textContent = title;
    c.chip.lastChild.textContent = `On the canvas: ${title}`;
  });
}

// ---------- media on the canvas: pictures, GIFs, videos ----------
// Markdown leaves a slot for each; the page asks the server for it over the socket and is given
// a private link (/media/…) to load. That covers files in an agent's folder, which plain HTTP
// cannot reach, and web links, which the server fetches so a site that refuses to be embedded,
// or a link to a page rather than the picture itself, still shows. YouTube plays in its player.
const mediaFound = new Map(); // "pid\nsrc" -> { url, kind } | { error } | "pending"
const youtubeId = (u) => /(?:youtube\.com\/(?:watch\?(?:[^#]*&)?v=|shorts\/|embed\/)|youtu\.be\/)([\w-]{11})/.exec(u)?.[1] ?? null;
function showMedia(pid, root) {
  // a picture pasted in as text and cut off: the server finds the file the agent was working with
  for (const el of root.querySelectorAll(".media[data-cut]:not([data-src])")) {
    el.dataset.src = "rescue:";
    const k = `${pid}\nrescue:`;
    if (!mediaFound.has(k)) { mediaFound.set(k, "pending"); send({ type: "media-rescue", project: pid, src: "rescue:" }); }
  }
  for (const el of root.querySelectorAll(".media[data-src]:not(.shown)")) {
    el.dataset.pid = pid;
    const src = el.dataset.src;
    const yt = youtubeId(src);
    if (yt) { fillMedia(el, { kind: "youtube", url: `https://www.youtube-nocookie.com/embed/${yt}` }); continue; }
    if (/^data:(image|video)\//.test(src)) { fillMedia(el, { kind: src.startsWith("data:video") ? "video" : "image", url: src }); continue; }
    const k = `${pid}\n${src}`;
    const got = mediaFound.get(k);
    if (got && got !== "pending") { fillMedia(el, got); continue; }
    // A plain link to a picture loads straight from the site: no trip through the server, which
    // would fetch the whole file before the page saw any of it. Only if the site refuses (some
    // block pictures shown elsewhere) does the server fetch it instead.
    if (!got && DIRECT_IMAGE.test(src)) { fillMedia(el, { kind: "image", url: src, direct: true }); continue; }
    if (!el.classList.contains("loading")) { el.classList.add("loading"); el.innerHTML = `<span class="spin"></span>Loading ${esc(el.dataset.alt || (/\.(mp4|m4v|webm|mov)/i.test(src) ? "video" : "picture"))}…`; }
    if (!got) {
      mediaFound.set(k, "pending");
      send({ type: "media", project: pid, src });
      // a server too old to know about media never answers: say so, rather than load forever
      setTimeout(() => {
        if (mediaFound.get(k) !== "pending") return;
        mediaArrived({ project: pid, src, error: "ClaudeCall did not answer. It may still be running an older version" });
        showStale("The server did not answer a request for a picture.");
      }, 15000);
    }
  }
}
const DIRECT_IMAGE = /^https?:\/\/[^\s"'<>]+\.(png|jpe?g|gif|webp|avif)(\?[^\s"'<>]*)?$/i;
function fillMedia(el, r) {
  const alt = el.dataset.alt || "";
  el.classList.remove("loading");
  el.classList.add("shown");
  if (r.error) {
    el.classList.add("failed");
    const link = /^https?:/i.test(el.dataset.src ?? "") ? ` <a href="${esc(el.dataset.src)}" target="_blank" rel="noopener noreferrer">Open the link</a>` : "";
    el.innerHTML = `${icon("x", 14)}<span>Could not show ${alt ? `“${esc(alt)}”` : esc((el.dataset.src ?? "").split("/").pop() || "this")}: ${esc(r.error)}.${link}</span>`;
    return;
  }
  if (r.kind === "youtube") el.innerHTML = `<iframe class="yt" src="${esc(r.url)}" title="${esc(alt || "video")}" allow="autoplay; encrypted-media; picture-in-picture; fullscreen" allowfullscreen loading="lazy"></iframe>`;
  // a short clip plays like a GIF: on its own, silent, looping; the controls are there for more
  else if (r.kind === "video") el.innerHTML = `<span class="mwrap"><video class="vid" src="${esc(r.url)}" controls loop muted playsinline autoplay preload="metadata"></video>${mediaButton("download", alt)}</span>`;
  else {
    // the light copy loads over a tiny blurred preview, in a space already the picture's size;
    // the original is kept for full size and for copying
    const dims = r.width && r.height ? ` width="${r.width}" height="${r.height}"` : "";
    // straight from a site, without saying which page it is shown on: that is what most sites that
    // refuse to be shown elsewhere check
    const direct = r.direct ? ` referrerpolicy="no-referrer"` : "";
    el.innerHTML = `<span class="mwrap${r.placeholder ? " pending" : ""}">${r.placeholder ? `<span class="ph" style="background-image:url('${r.placeholder}')"></span>` : ""}<img class="pic" src="${esc(r.url)}" alt="${esc(alt)}"${dims}${direct} decoding="async"${r.full ? ` data-full="${esc(r.full)}"` : ""}>${mediaButton("copy", alt)}</span>`;
    const img = el.querySelector("img");
    const shown = () => img.closest(".mwrap")?.classList.remove("pending");
    if (img.complete) shown(); else img.addEventListener("load", shown, { once: true });
  }
  if ((alt || r.rescued) && r.kind !== "youtube") el.insertAdjacentHTML("beforeend", `<span class="mcap">${esc(alt)}${r.rescued ? `${alt ? " · " : ""}shown from ${esc(tilde(r.rescued))}` : ""}</span>`);
  // one that will not load says so, rather than collapsing into a thin empty bar
  const m = el.querySelector("img, video");
  if (m) m.onerror = () => {
    el.classList.remove("shown");
    // refused when loaded straight from the site: have the server fetch it instead
    if (r.direct) {
      const k = `${el.dataset.pid}\n${el.dataset.src}`;
      mediaFound.set(k, "pending");
      el.classList.add("loading");
      return void send({ type: "media", project: el.dataset.pid, src: el.dataset.src, proxy: true });
    }
    fillMedia(el, { error: "it would not load" });
  };
}
// ---------- copying from the canvas ----------
/** The small button in a picture's corner: copy for a picture or GIF, download for a video. */
function mediaButton(kind, alt = "") {
  return `<button class="mbtn" data-act="${kind}" title="${kind === "copy" ? "Copy picture" : "Download video"}" aria-label="${kind === "copy" ? "Copy picture" : "Download video"}">${icon(kind, 15)}</button>`;
}
/** Give pictures that arrived without one (from a tool's output) their copy button. */
function addMediaButtons(root) {
  for (const img of root.querySelectorAll("img.pic")) {
    if (img.closest(".mwrap")) continue;
    const wrap = Object.assign(document.createElement("span"), { className: "mwrap" });
    img.replaceWith(wrap);
    wrap.appendChild(img);
    wrap.insertAdjacentHTML("beforeend", mediaButton("copy", img.alt));
  }
}
/** Briefly show on a button what just happened. */
function flashButton(b, ok, label) {
  const was = b.innerHTML;
  b.innerHTML = ok ? icon("check", 15) : icon("x", 15);
  b.classList.add(ok ? "done" : "fail");
  if (label) b.dataset.tip = label;
  setTimeout(() => { b.innerHTML = was; b.classList.remove("done", "fail"); delete b.dataset.tip; }, 1400);
}
/** A picture as PNG, the one image type every clipboard takes; a GIF gives its current frame. */
function pngOf(img) {
  return new Promise((resolve, reject) => {
    const c = document.createElement("canvas");
    c.width = img.naturalWidth; c.height = img.naturalHeight;
    try { c.getContext("2d").drawImage(img, 0, 0); } catch (e) { return reject(e); }
    c.toBlob((b) => (b ? resolve(b) : reject(new Error("could not encode"))), "image/png");
  });
}
/** The full-size original of a picture shown as a light copy, loaded for copying. */
function original(img) {
  const src = img.dataset.full;
  if (!src || src === img.src) return Promise.resolve(img);
  return new Promise((resolve, reject) => {
    const o = new Image();
    o.onload = () => resolve(o);
    o.onerror = () => resolve(img); // the light copy will do
    o.src = src;
  });
}
async function copyPicture(img, b) {
  try {
    // the promise goes straight into the ClipboardItem: Safari only allows the write inside the click
    await navigator.clipboard.write([new ClipboardItem({ "image/png": original(img).then(pngOf) })]);
    flashButton(b, true, /\.gif|image\/gif/i.test(img.src) ? "Copied (a GIF copies as a still)" : "Copied");
  } catch {
    // no image clipboard here (an older browser, or plain http away from this machine): the link, then
    try { await navigator.clipboard.writeText(new URL(img.src, location.href).href); flashButton(b, true, "Copied the link"); }
    catch { flashButton(b, false, "Could not copy"); }
  }
}
async function copyText(text, b) {
  try { await navigator.clipboard.writeText(text); if (b) flashButton(b, true, "Copied"); return true; }
  catch {
    // the clipboard API needs a secure page; the old way works everywhere else
    const t = Object.assign(document.createElement("textarea"), { value: text });
    t.style.position = "fixed"; t.style.opacity = "0";
    document.body.appendChild(t); t.select();
    const ok = document.execCommand("copy");
    t.remove();
    if (b) flashButton(b, ok, ok ? "Copied" : "Could not copy");
    return ok;
  }
}
/** Plain text of a canvas card's body: what you would get by selecting all of it. */
const cardText = (el) => el.innerText.replace(/\n{3,}/g, "\n\n").trim();

document.addEventListener("click", (e) => {
  const b = e.target.closest?.(".mbtn, .codecopy, .artcopy");
  if (!b) return;
  e.preventDefault();
  e.stopPropagation();
  if (b.classList.contains("artcopy")) return copyText(cardText(b.closest(".art").querySelector(".body")), b);
  if (b.classList.contains("codecopy")) return copyText(b.parentElement.querySelector("code")?.innerText ?? "", b);
  const m = b.parentElement.querySelector("img, video");
  if (b.dataset.act === "copy" && m) return copyPicture(m, b);
  if (b.dataset.act === "download" && m) {
    const a = Object.assign(document.createElement("a"), { href: m.currentSrc || m.src, download: (b.closest(".media")?.dataset.alt || "video").replace(/[^\w -]+/g, "").trim() || "video" });
    document.body.appendChild(a); a.click(); a.remove();
    flashButton(b, true, "Downloading");
  }
}, true);

/** Code blocks on the canvas get a copy button of their own. */
function addCodeButtons(root) {
  for (const pre of root.querySelectorAll("pre")) {
    if (pre.querySelector(".codecopy")) continue;
    pre.insertAdjacentHTML("beforeend", `<button class="codecopy" title="Copy code">${icon("copy", 13)}</button>`);
  }
}

// Selecting text on the canvas offers a Copy button beside it. Selection and Cmd/Ctrl-C work as usual too.
const selCopy = Object.assign(document.createElement("button"), { className: "selcopy", innerHTML: `${icon("copy", 13)}<span>Copy</span>` });
selCopy.hidden = true;
document.body.appendChild(selCopy);
let selText = "";
function placeSelCopy() {
  const sel = getSelection();
  const text = sel && !sel.isCollapsed ? sel.toString().trim() : "";
  const inside = text && sel.anchorNode && $("canvasScroll").contains(sel.anchorNode);
  if (!inside) { selCopy.hidden = true; return; }
  selText = text;
  const r = sel.getRangeAt(0).getBoundingClientRect();
  selCopy.style.left = `${Math.min(innerWidth - 90, Math.max(8, r.right - 40))}px`;
  selCopy.style.top = `${Math.max(8, r.top - 38)}px`;
  selCopy.hidden = false;
}
document.addEventListener("selectionchange", () => requestAnimationFrame(placeSelCopy));
$("canvasScroll").addEventListener("scroll", () => (selCopy.hidden = true));
selCopy.addEventListener("mousedown", (e) => e.preventDefault()); // keep the selection while clicking
selCopy.onclick = async () => { await copyText(selText, selCopy); setTimeout(() => (selCopy.hidden = true), 900); };

/** A banner saying the server needs a restart to match the page. */
function showStale(why) {
  $("staleText").textContent = `${why} Restart it to use the latest: in its terminal press Ctrl-C, then run npm start.`;
  $("staleBar").hidden = false;
}
$("staleClose").onclick = () => ($("staleBar").hidden = true);

function mediaArrived(m) {
  const r = m.error ? { error: m.error } : { url: m.url, kind: m.kind, rescued: m.rescued, full: m.full, placeholder: m.placeholder, width: m.width, height: m.height, direct: m.direct };
  mediaFound.set(`${m.project}\n${m.src}`, r);
  for (const el of document.querySelectorAll(".media[data-src]:not(.shown)")) {
    if (el.dataset.src === m.src && el.dataset.pid === m.project) fillMedia(el, r);
  }
}
/** Re-render markdown into an element, keeping media already showing so a video does not restart. */
function renderInto(el, pid, md) {
  const keep = new Map();
  for (const m of el.querySelectorAll(".media.shown")) if (!keep.has(m.dataset.src)) keep.set(m.dataset.src, m);
  // a diagram already drawn stays as it is while the text around it streams in
  for (const d of el.querySelectorAll(".diagram.drawn")) if (!keep.has(`d:${d.dataset.src}`)) keep.set(`d:${d.dataset.src}`, d);
  el.innerHTML = `<div class="screen">${renderMarkdown(md)}</div>`;
  for (const m of el.querySelectorAll(".media[data-src]")) {
    const old = keep.get(m.dataset.src);
    if (old) { m.replaceWith(old); keep.delete(m.dataset.src); }
  }
  for (const d of el.querySelectorAll(".diagram:not(.drawn)")) {
    const old = keep.get(`d:${d.dataset.src}`);
    if (old) { d.replaceWith(old); keep.delete(`d:${d.dataset.src}`); }
  }
  drawDiagrams(el).catch(() => {});
  showMedia(pid, el);
  addCodeButtons(el);
}

// any picture in the panel opens full size; a click anywhere closes it
document.addEventListener("click", (e) => {
  const img = e.target.closest?.("img.pic");
  if (!img?.src) return;
  const box = Object.assign(document.createElement("div"), { className: "lightbox" });
  // full size means the original, not the light copy shown on the canvas
  box.appendChild(Object.assign(document.createElement("img"), { src: img.dataset.full || img.src, alt: img.alt }));
  box.onclick = () => box.remove();
  document.body.appendChild(box);
});

// ---------- decisions in the panel ----------
// A paused action, a plan to review, or the agent's own questions, answered with a click. The
// same request can be answered out loud; whichever comes first wins, and the card shows it.
const askCards = new Map(); // requestId -> card, until answered
function feedAsk(m) {
  const c = card(m.project, m.turn);
  const i = m.input ?? {};
  const kind = m.tool === "ExitPlanMode" ? "plan" : m.tool === "AskUserQuestion" ? "questions" : "action";
  const n = Object.assign(document.createElement("div"), { className: `askcard ${kind}` });
  n.dataset.kind = kind;
  const button = (html, cls, fn) => { const b = Object.assign(document.createElement("button"), { className: cls }); b.innerHTML = html; b.onclick = fn; return b; };
  const answer = (type, extra = {}) => {
    send({ type, project: m.project, requestId: m.requestId, ...extra });
    for (const it of queue.slice()) if (it.requestId === m.requestId) removeItem(it);
  };
  const acts = Object.assign(document.createElement("div"), { className: "acts" });
  if (kind === "plan") {
    n.innerHTML = `<div class="head">${esc(nameOf(m.project))} has a plan for you to review</div><div class="screen">${renderMarkdown(String(i.plan ?? ""))}</div>`;
    const note = Object.assign(document.createElement("textarea"), { rows: 2, placeholder: "What should change? (optional, sent with Keep planning)" });
    acts.append(
      button("Approve", "yes", () => answer("grant")),
      button("Keep planning", "", () => answer("deny", { message: note.value.trim() ? `The lead wants changes to the plan before you start: ${note.value.trim()}` : "The lead wants you to keep planning before you start. Ask what to change if it is not clear." })),
    );
    n.append(note, acts);
  } else if (kind === "questions") {
    n.innerHTML = `<div class="head">${esc(nameOf(m.project))} asks</div>`;
    const qs = Array.isArray(i.questions) ? i.questions : [];
    const picked = {};
    const submit = button("Send answers", "yes", () => answer("grant", { answers: picked }));
    const check = () => (submit.disabled = qs.some((q) => !picked[q.question]));
    for (const q of qs) {
      const box = Object.assign(document.createElement("div"), { className: "qbox" });
      box.innerHTML = `<div>${q.header ? `<span class="tag">${esc(String(q.header))}</span> ` : ""}${esc(String(q.question ?? ""))}</div>`;
      const opts = Object.assign(document.createElement("div"), { className: "opts" });
      const chosen = new Set();
      const other = Object.assign(document.createElement("input"), { placeholder: "Other…" });
      const sync = () => { if (chosen.size) picked[q.question] = [...chosen].join(", "); else delete picked[q.question]; check(); };
      for (const o of q.options ?? []) {
        const b = button(`<b>${esc(String(o.label ?? ""))}</b>${o.description ? `<small>${esc(String(o.description))}</small>` : ""}`, "opt", () => {
          const on = !chosen.has(o.label);
          if (!q.multiSelect) { chosen.clear(); opts.querySelectorAll(".opt").forEach((x) => x.classList.remove("on")); }
          if (on) chosen.add(o.label); else chosen.delete(o.label);
          b.classList.toggle("on", on);
          other.value = "";
          sync();
        });
        opts.appendChild(b);
      }
      other.oninput = () => {
        chosen.clear();
        opts.querySelectorAll(".opt").forEach((x) => x.classList.remove("on"));
        if (other.value.trim()) picked[q.question] = other.value.trim(); else delete picked[q.question];
        check();
      };
      box.append(opts, other);
      n.appendChild(box);
    }
    check();
    acts.append(submit, button("Skip", "no", () => answer("deny", { message: "The lead skipped your questions. Use your best judgment, and say what you assumed." })));
    n.appendChild(acts);
  } else {
    n.innerHTML = `<div class="head">${esc(nameOf(m.project))} wants to ${esc(m.phrase ?? m.tool)}</div>${m.detail ? `<pre>${esc(m.detail)}</pre>` : ""}${m.text ? `<div class="why">${esc(m.text)}</div>` : ""}`;
    acts.append(button("Allow", "yes", () => answer("grant")), button("Always allow", "", () => answer("grant", { scope: "always" })), button("Deny", "no", () => answer("deny")));
    n.appendChild(acts);
  }
  if (kind === "action") {
    c.el.appendChild(n);
    c.last = { kind: "ask", node: n };
  } else {
    const a = artifact(m.project, `ask:${m.requestId}`, { kind: kind === "plan" ? "plan review" : "questions", title: kind === "plan" ? (/^\s*#{1,3}\s+(.+)$/m.exec(String(i.plan ?? ""))?.[1]?.trim() || "Plan for review") : `${nameOf(m.project)} asks` });
    a.el.classList.add("needs");
    a.body.appendChild(n);
    showMedia(m.project, n);
    canvasChip(m.project, m.turn, a, kind === "plan" ? "Plan waiting for your review" : "Questions waiting for you");
    if (m.project === focusedId) showArt(a);
  }
  askCards.set(m.requestId, n);
  scrollFeed();
}
function askAnswered(m) {
  const n = askCards.get(m.requestId);
  if (!n) return;
  askCards.delete(m.requestId);
  n.classList.add("settled", m.allow ? "allowed" : "refused");
  n.querySelectorAll("button, textarea, input").forEach((x) => (x.disabled = true));
  const words = {
    plan: m.allow ? "Approved" : "Sent back to keep planning",
    questions: m.allow ? "Answered" : "Skipped",
    action: m.allow ? (m.always ? "Allowed from now on" : "Allowed") : "Denied",
  }[n.dataset.kind];
  n.appendChild(Object.assign(document.createElement("div"), { className: "verdict", textContent: words }));
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
  // Only what needs the lead's reply is queued and announced. The rest — work finished, a problem
  // hit, a long stretch — goes on the agent's card and in the feed, without a ring or a heads-up:
  // while the lead talks to Juno, Iris finishing is not worth interrupting for.
  const needsReply = m.needsReply ?? (m.kind === "permission" || m.kind === "question");
  if (!needsReply) {
    if (m.project === centralId) return; // her own results are on her card; she never reports on herself
    unread.set(m.project, { kind: m.kind, text: m.text, at: Date.now() });
    feedNote(`${m.name}: ${m.text}`, m.project);
    render();
    return;
  }
  // the assistant asking for herself speaks as herself, not of herself
  if (m.project === centralId) m = { ...m, self: true, text: m.text.replace(new RegExp(`^${centralName} wants to`), "I'd like to").replace(new RegExp(`^${centralName} asks:`), "I have a question:") };
  const item = { ...m, uid: ++queueSeq, at: m.at ?? Date.now() };
  // news replaces older news from the same agent: only its latest report is worth hearing
  if (item.kind === "finished" || item.kind === "failed") {
    for (const old of queue.filter((i) => i.project === item.project && (i.kind === "finished" || i.kind === "failed"))) removeItem(old);
  }
  queue.push(item);
  feedNote(`${m.name}: ${m.text}`, m.project);
  if (!replaying) ring(identityOf(m.project));
  // already summed up in the welcome-back briefing: not offered again as a fresh heads-up
  else att = { ...att, announced: new Set([...att.announced, item.uid]), lastHeadsUp: Date.now() };
  notifyAway(item);
  // A request from whoever you are talking to is part of that conversation: ask it now. Hers
  // above all — talking to Ada, you never hear "Ada is waiting on you" — even while holding calls,
  // which is about the others.
  const fromFloor = item.project === focusedId && (item.onLine || item.self);
  if (fromFloor && (!att.hold || item.self)) obey(attention.urgent(att, item, Date.now()));
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
  // moving the line clears the voice, so it happens before anything is said, never after:
  // otherwise "next" would switch agents and wipe the very line that says what they need
  for (const a of result.actions) if (a.type === "focus") { quietly(a.project); voice.clear(); send({ type: "focus", project: a.project }); }
  for (const line of result.say) central.say(line);
  let passthrough = false;
  for (const a of result.actions) {
    if (a.type === "passthrough") passthrough = true;
    else if (a.type === "dismiss") { heardAt.set(a.item.project, Date.now()); lastNews = { ...a.item, heardAt: Date.now() }; removeItem(a.item); }
    else if (a.type !== "focus") settle(a.item, a);
  }
  render();
  return passthrough;
}

/**
 * The next switch to this agent has already been spoken for: skip its handover line. Forgotten
 * after a few seconds, so a switch that never happened (already there, or refused) cannot silence
 * a real one later.
 */
let quietTimer = null;
function quietly(id) {
  quietHandover = id;
  clearTimeout(quietTimer);
  quietTimer = setTimeout(() => { if (quietHandover === id) quietHandover = null; }, 5000);
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
  // on a phone, choosing someone brings you back to the call to talk to them
  if (phone.matches && id) setTab("call");
  if (!onCall || !id) return;
  voice.clear();
  userPaused = false;
  // the circle moves now, and whatever you say next goes to them, not whoever had the floor
  wantFocus = id;
  wantAt = Date.now();
  focusedId = id;
  send({ type: "focus", project: id });
  render();
}

/**
 * "Tell me more", "give me the full summary". Calls are short by default, so news is read as one
 * line; this is the way to the whole of it. Just after a piece of news, it is that agent's full
 * report, in its own voice, sentence by sentence. Otherwise whoever you are talking to is asked
 * for the full version, and gives all of it — nothing on this path is clipped.
 */
function more() {
  voice.clear();
  userPaused = false;
  const recent = lastNews && Date.now() - lastNews.heardAt < 10 * 60_000 && lastNews.full && lastNews.full.length > lastNews.text.length - 10;
  if (recent && (!focusedId || focusedId === centralId || focusedId === lastNews.project)) {
    const p = project(lastNews.project);
    for (const s of lastNews.full.match(/[^.!?]+[.!?]+["')\]]*|\S[^.!?]*$/g) ?? [lastNews.full]) {
      voice.say(s.trim(), 0, { identity: p?.identity ?? identityOf(lastNews.project), speaker: lastNews.project });
    }
    lastNews = null;
    return;
  }
  ask("Give me the full summary of that, in as much detail as it needs.", "tell me more");
}

/** Stand-up: once round the table, each agent in its own voice with its own latest line. */
function standup() {
  const list = team();
  voice.clear();
  central.standupIntro(list.length);
  for (const p of list) {
    const waitingItem = queue.find((i) => i.project === p.id && (i.kind === "permission" || i.kind === "question"));
    // only whole sentences the agent itself said are spoken: screen labels are clipped
    const said = lastSaid.get(p.id);
    const line = p.state === "working" ? `${p.name} here. Still working.${said ? ` ${said}` : ""}`
      : p.report ? `${p.name} here. ${p.report}` : central.standupEmpty(p.name);
    voice.say(waitingItem ? `${line} And I'm waiting on you.` : line, 0, { record: false, keep: true, identity: p.identity, speaker: p.id });
    // its news has now been heard in its own words: not offered again as "has news"
    if (p.report && p.state !== "working") {
      for (const i of queue.slice()) if (i.project === p.id && (i.kind === "finished" || i.kind === "failed")) removeItem(i);
      heardAt.set(p.id, Date.now());
    }
  }
}

// ---------- server connection ----------
const pendingSegments = new Map();

// The access code is kept per device and sent as a subprotocol, never in the URL, so a link on
// its own is useless. A refused handshake closes with 1006 and no reason, so a connection that
// never opened is treated as a wrong code.
const CODE_KEY = "buddyCode";
// opened by the Mac app, which knows the code: take it from the address, then drop it from there
{
  const given = new URLSearchParams(location.hash.slice(1)).get("code");
  if (given) {
    try { localStorage.setItem(CODE_KEY, given.trim().toLowerCase()); } catch {}
    history.replaceState(null, "", location.pathname + location.search);
  }
}
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
  // on a phone the keyboard would cover the page before it has been read
  if (!phone.matches) $("codeBox").focus();
  typeExamples();
}

// ---------- the opening page: things you might say, typed out one after another ----------
const EXAMPLES = [
  "Ada, start a project for a recipe app",
  "Juno, run the tests and fix what fails",
  "What's waiting for me?",
  "Give the login page to Rex",
  "Iris, show me how the data flows",
  "Hold my calls for a bit",
];
let typing = 0;
function typeExamples() {
  if (typing) return;
  const el = $("wType");
  const still = matchMedia("(prefers-reduced-motion: reduce)").matches;
  let i = 0, n = 0, back = false;
  const step = () => {
    if (!document.body.classList.contains("locked")) { typing = 0; return; }
    const text = EXAMPLES[i % EXAMPLES.length];
    if (still) { el.textContent = text; i++; typing = setTimeout(step, 3500); return; }
    n += back ? -1 : 1;
    el.textContent = text.slice(0, n);
    let wait = back ? 22 : 45 + Math.random() * 50;
    if (!back && n >= text.length) { back = true; wait = 1900; }
    else if (back && n <= 0) { back = false; i++; wait = 350; }
    typing = setTimeout(step, wait);
  };
  typing = setTimeout(step, 900);
}

// ---------- Settings: how a phone or tablet joins ----------
function showReach(lan) {
  // reached already through a name a phone can use too (Tailscale, a proxy): that address works
  const here = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname) ? null : location.origin;
  const url = here ?? lan.find((u) => u.startsWith("https://")) ?? null;
  $("reachUrl").textContent = url ?? "—";
  $("reachCode").textContent = code || "—";
  $("reachBox").hidden = !url;
  $("reachText").textContent = url
    ? "Open this address on your phone or tablet (or type it into the ClaudeCall Android app) and enter the access code."
    : "Only this computer can reach ClaudeCall right now. To join from a phone, run: npm run service install -- --lan (same Wi-Fi), or use Tailscale (see the README).";
}

// ---------- after connecting: is Claude Code installed and signed in? ----------
/** The server build this page came from; a different one after a reconnect means an update. */
let serverBuild = "";
let updatePending = false;
let claudeSkipped = false;
let claudePoll = 0;
function markCheck(id, ok, note) {
  $(id).className = `check ${ok ? "ok" : "no"}`;
  $(id).querySelector(".mark").textContent = ok ? "✓" : "!";
  $(id).querySelector("small").textContent = note;
}
function claudeStatus(m) {
  const ready = m.installed && m.loggedIn;
  if (ready || claudeSkipped) {
    clearInterval(claudePoll);
    claudePoll = 0;
    // just signed in: a moment to see it worked, then out of the way
    if (ready && !$("setup").hidden) {
      markCheck("chkInstalled", true, `Version ${m.version ?? "unknown"}`);
      markCheck("chkSigned", true, `Signed in${m.method ? ` (${m.method})` : ""}`);
      $("stepInstall").hidden = $("stepSign").hidden = true;
      $("setupMsg").textContent = "Claude Code is ready.";
      setTimeout(() => ($("setup").hidden = true), 1200);
    } else $("setup").hidden = true;
    return;
  }
  $("setup").hidden = false;
  markCheck("chkInstalled", m.installed, m.installed ? `Version ${m.version ?? "unknown"}` : "Not found on the computer running ClaudeCall");
  markCheck("chkSigned", m.loggedIn, !m.installed ? "After installing" : m.loggedIn ? `Signed in${m.method ? ` (${m.method})` : ""}` : "Not signed in yet");
  if (!m.installed) $("chkSigned").className = "check";
  $("stepInstall").hidden = m.installed;
  $("stepSign").hidden = !m.installed || m.loggedIn;
  // the sign-in opens in a terminal on the computer itself: from a phone, the command instead
  $("signButtons").hidden = !m.sameComputer;
  $("signRemote").hidden = $("signCmd").hidden = !!m.sameComputer;
}
$("setupCheck").onclick = () => { $("setupMsg").textContent = "Checking…"; send({ type: "claude-check" }); setTimeout(() => { if ($("setupMsg").textContent === "Checking…") $("setupMsg").textContent = ""; }, 1500); };
$("setupSkip").onclick = () => { claudeSkipped = true; $("setup").hidden = true; clearInterval(claudePoll); };
const signIn = (kind) => {
  $("setupMsg").textContent = "Opening the sign-in…";
  send({ type: "claude-login", kind });
};
$("signClaude").onclick = () => signIn("claudeai");
$("signConsole").onclick = () => signIn("console");
$("keyForm").onsubmit = (e) => {
  e.preventDefault();
  const key = $("keyBox").value.trim();
  if (!key) return;
  $("setupMsg").textContent = "Saving…";
  send({ type: "claude-key", key });
  $("keyBox").value = "";
};
for (const b of document.querySelectorAll("[data-copy]")) {
  b.onclick = async () => {
    try { await navigator.clipboard.writeText(b.previousElementSibling.textContent); b.textContent = "Copied"; } catch { b.textContent = "Select it"; }
    setTimeout(() => (b.textContent = "Copy"), 1600);
  };
}
function claudeLogin(m) {
  if (m.error) { $("setupMsg").textContent = m.error; return; }
  $("setupMsg").textContent = "A terminal opened on your computer. Finish signing in in the browser it opens; this page notices when you are done.";
  // keep checking while the lead signs in, for a few minutes
  clearInterval(claudePoll);
  let tries = 0;
  claudePoll = setInterval(() => {
    if ($("setup").hidden || ++tries > 60) { clearInterval(claudePoll); claudePoll = 0; return; }
    send({ type: "claude-check" });
  }, 3000);
}

function connect() {
  if (!code) return askForCode("");
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
    $("ears").textContent = "Reconnecting…";
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
/** Send to the server; true if it went, false when not connected. */
const send = (m) => { if (ws?.readyState !== 1) return false; ws.send(JSON.stringify(m)); return true; };

function onServer(m) {
  const mine = m.project === undefined || m.project === focusedId;
  switch (m.type) {
    case "stt":
      $("ears").textContent = { loading: m.recogniser === "accurate" ? "Loading accurate hearing…" : "Voice starting…", ready: "Voice ready", error: "Voice unavailable — type instead" }[m.state];
      $("ears").title = m.state === "loading" ? "The first time, the recognizer is downloaded; after that it starts in seconds." : "";
      $("ears").className = "pill " + (m.state === "ready" ? "ok" : "warn");
      break;
    case "central":
      centralIdentity = m.identity;
      centralId = m.id ?? centralId;
      centralName = m.name ?? centralName;
      homeDir = m.home ?? "";
      central.setIdentity(m.identity, centralId, centralName);
      render();
      break;
    case "stale": showStale(`ClaudeCall's code changed after it started (${m.files.slice(0, 3).join(", ")}${m.files.length > 3 ? "…" : ""}).`); break;
    case "refined":
      // the "You" caption shows what was understood once the clean-up pass is done
      if (m.changed) showYou(m.text);
      break;
    case "renamed": feedNote(`Renamed to ${m.name}.`, m.project); renamed(m.project, m.name); break;
    case "voices": voiceCounts = m.counts ?? {}; voiceConfident = new Set(m.confident ?? []); relearn = new Set(m.relearn ?? []); render(); maybeNudgeTeach(); break;
    case "teach-progress": teachProgress(m); break;
    case "voiceprint": feedNote(`${nameOf(m.project)} now knows how your voice says its name (${m.count} sample${m.count === 1 ? "" : "s"}).`, m.project); break;
    case "taught": taught(m); break;
    case "roster": {
      const first = !rosterSeen;
      rosterSeen = true;
      projects = m.projects;
      // a roster sent before the server took the switch asked for here: not where the floor is now
      const stale = !!wantFocus && m.focused !== wantFocus && Date.now() - wantAt < 2500;
      if (wantFocus && (m.focused === wantFocus || !stale)) wantFocus = null;
      const changed = !stale && confirmedFocus !== m.focused;
      const left = confirmedFocus;
      if (!stale) { confirmedFocus = m.focused; focusedId = m.focused; }
      // a detour to the assistant remembers who you came from; going to anyone else ends it
      const returning = changed && !!left && left === centralId && m.focused === cameFrom;
      if (changed) cameFrom = m.focused === centralId && left && left !== centralId ? left : null;
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
      if (greetPending) { greetPending = false; central.greet(team()); setTimeout(maybeNudgeTeach, 2500); }
      else if (changed && focusedId && onCall) {
        if (quietHandover !== focusedId) central.handover(focused(), { heard: Date.now() - (heardAt.get(focusedId) ?? 0) < 120_000, from: cameFrom ? project(cameFrom) : null, returning });
        heardAt.set(focusedId, Date.now());
        // what this agent is waiting on you for is part of the conversation now: ask it
        const pending = attention.order(queue).find((i) => i.project === focusedId && (i.kind === "permission" || i.kind === "question"));
        if (pending && quietHandover !== focusedId) obey(attention.urgent(att, pending, Date.now()));
      }
      if (changed) { quietHandover = null; unread.delete(focusedId); }
      maybeNudgeTeach(); // a newly seated agent joins an offer to teach names that is on screen
      if ($("settingsDlg").open) drawVoices(); // a voice changed by Ada or an agent shows at once
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
      done?.(m.text || "", m.match ?? null);
      break;
    }
    case "turn": {
      if (dropped.has(key(m.project, m.turn))) break;
      if (m.intro) intro = { project: m.project, turn: m.turn };
      if (m.project === focusedId) {
        currentTurn = m.turn;
        working = true;
        if (m.queued) liveTurns.add(m.turn);
        else liveTurns = new Set([m.turn]);
      }
      const c = card(m.project, m.turn);
      // what the clean-up pass changed is shown, quietly, under what it understood
      const heardAs = /\s*\[speech recognition heard: "([^"]*)"\]\s*$/.exec(m.text);
      const asked = heardAs ? m.text.slice(0, heardAs.index) : m.text;
      // its hello was asked for by ClaudeCall, not said by you
      c.el.querySelector(".qt").textContent = m.intro ? "(put through: says hello)" : asked;
      if (heardAs && !c.el.querySelector(".heardas")) c.el.querySelector(".q").insertAdjacentHTML("afterend", `<div class="heardas">heard: “${esc(heardAs[1])}”</div>`);
      m = { ...m, text: asked };
      const tag = m.assigned ? "from Ada" : m.queued ? "queued behind work" : m.background ? "background" : "";
      if (tag && !c.el.querySelector(".bg")) c.el.querySelector(".who").insertAdjacentHTML("afterend", `<span class="bg">${tag}</span>`);
      activity.set(m.project, { text: m.intro ? "Saying hello and catching you up." : m.text.length > 90 ? m.text.slice(0, 89) + "…" : m.text, live: true });
      const pipe = pipeline.get(m.project);
      if (pipe && m.assigned && pipe.step < 1) pipeline.set(m.project, { step: 1, at: Date.now() });
      scrollFeed();
      break;
    }
    case "say":
      feedSaid(m.project, m.turn, m.text, m.spoken);
      activity.set(m.project, { text: m.text, live: true });
      lastSaid.set(m.project, m.text);
      bumpPipeline(m.project, 2);
      // only the agent on the line has a voice; the rest wait in the queue
      if (m.spoken && mine && liveTurns.has(m.turn)) {
        voice.say(m.text, m.turn, { identity: identityOf(m.project), speaker: m.project });
        // the floor has spoken since any heads-up: a yes from now on is for this agent
        if (!att.floorSpoke) att = { ...att, floorSpoke: true };
      }
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
    case "tool_result": feedToolResult(m.project, m.turn, m.id, m.ok, m.summary, m.detail, m.images); break;
    case "screen": feedScreen(m.project, m.turn, m.text); break;
    case "action": feedAction(m.project, m.turn, m); break;
    case "permission":
      feedNote(`${nameOf(m.project)} ${m.blocked ? "was stopped by the safety check" : `is waiting for your yes: ${m.phrase ?? m.tool}`}${m.detail ? ` — ${m.detail}` : ""}`, m.project);
      activity.set(m.project, { text: m.blocked ? "Stopped by the safety check." : `Waiting for your yes: ${m.phrase ?? m.tool}`, live: false });
      if (m.requestId && !m.blocked) feedAsk(m);
      break;
    case "answered":
      askAnswered(m);
      for (const i of queue.slice()) if (i.requestId === m.requestId) removeItem(i);
      feedNote(`${nameOf(m.project)}: ${m.allow ? (m.always ? "allowed from now on" : "allowed") : "denied"} — ${m.phrase}`, m.project);
      break;
    case "notify": enqueue(m); break;
    case "handoff":
      quietHandover = m.to;
      feedNote(`${nameOf(m.from)} put you through to ${nameOf(m.to)}${m.note ? `: “${m.note}”` : ""}`, m.to);
      break;
    case "media": mediaArrived(m); break;
    case "picked": picked(m); break;
    case "call-control": afterSpeech(() => callControl(m.do)); break;
    case "app-setting": appSetting(m.name, m.value); break;
    case "name-test": nameTested(m); break;
    case "claude-status": claudeStatus(m); break;
    case "questions": showQuestions(m); break;
    case "introducing": quietHandover = m.project; break;
    case "hello":
      // the server was updated while this page was open: load the new page that goes with it
      if (serverBuild && m.build !== serverBuild && !onCall) return location.reload();
      if (serverBuild && m.build !== serverBuild) feedNote("ClaudeCall was updated. It will reload when this call ends.", null);
      if (!serverBuild || !onCall) serverBuild = m.build;
      updatePending = serverBuild !== m.build;
      break;
    case "control-done": controlDone(m); break;
    case "reach": showReach(m.lan ?? []); break;
    case "claude-login": claudeLogin(m); break;
    case "tts-capable": ttsCapable = !!m.ok; $("stereoRow").hidden = !ttsCapable; useStereo(); break;
    case "tts": { const w = ttsWaiting.get(m.id); ttsWaiting.delete(m.id); if (w) m.wav ? w.resolve(m.wav) : w.reject(new Error(m.error ?? "no audio")); break; }
    case "briefing": briefing(m); break;
    case "undo-preview": undoPreview(m); break;
    case "undone":
      feedNote(`${nameOf(m.project)}'s last piece of work was undone${m.files?.length ? `: ${m.files.join(", ")} put back` : ""}.`, m.project);
      central.say(m.files?.length ? `Undone. ${nameOf(m.project)}'s changes are rolled back.` : "Nothing had changed, so there was nothing to roll back.");
      break;
    case "hearing": hearingSettings(m); break;
    case "btw": {
      const c = card(m.project, m.turn || 0);
      const n = Object.assign(document.createElement("div"), { className: m.phase === "asked" ? "aside" : "said" });
      n.textContent = m.phase === "asked" ? `by the way: ${m.text}` : `${m.text}${m.queued ? "  (queued as a follow-up)" : ""}`;
      c.el.appendChild(n);
      c.last = { kind: "btw", node: n };
      scrollFeed();
      // answered mid-task, in the agent's own voice, if you are still talking to it
      if (m.phase === "answer" && m.project === focusedId) voice.say(m.text, 0, { identity: identityOf(m.project), speaker: m.project });
      break;
    }
    case "note":
      // a refused rename is shown where the name was typed, so it can be fixed there
      if (m.problem && renaming) { renameRefused(m.text); break; }
      feedNote(m.text, m.project, !!m.problem); if (m.problem && onCall) central.say(m.text.split(/(?<=\.)\s/)[0]); break;
    case "done":
      finishCard(m.project, m.turn, m.interrupted);
      activity.delete(m.project); // the seat falls back to the agent's own report
      // its hello is over: now what it is waiting on you for, if anything
      if (intro && intro.project === m.project && intro.turn === m.turn) {
        intro = null;
        const pending = attention.order(queue).find((i) => i.project === m.project && i.kind === "permission");
        if (pending && m.project === focusedId) afterSpeech(() => obey(attention.urgent(att, pending, Date.now())));
      }
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
const mustKeep = (t) => LOCAL.some((re) => re.test(t)) || attention.classify(t) !== null || projects.some((p) => t === norm(p.name) || t.startsWith(norm(p.name) + " "))
  // a name as the recognizer misheard it, said on its own: "Aida", "hey Mylo"
  || !!calledBy(t, projects);

let inputTyped = false; // the line being handled was typed, not spoken
function heardText(raw, { typed = false, voicedMs = Infinity, match = null } = {}) {
  inputTyped = typed;
  // learning how the lead says a name: everything heard is a try at it, nothing is routed
  if (teach && !typed) return teachHeard(raw);
  // The lead's own voice saying a name they taught, recognised by its sound — the recognizer
  // often writes a name as something else entirely ("do" for Juno, "photo" for Otto). Only used
  // when the words do not already name someone, answer a question, or ask for a command. A strong
  // match is trusted on its sound; a weak one only if the words hold something that sounds like
  // the name. Only a name said on its own moves the line ("Juno", "hey Juno"). Within a sentence
  // its sound proves nothing: "add a effect" sounds like "Ada effect", and used to switch to Ada.
  if (!typed && match && project(match.project)) {
    const words = norm(raw).split(" ").filter(Boolean);
    const alone = words.length === 1 || (words.length === 2 && /^(hey|hi|hello|okay|ok|oh|um|please|yo)$/.test(words[0]));
    const r = words.length ? route(raw, projects) : { kind: "ask" };
    const p = project(match.project);
    const backed = match.strength !== "weak" || soundsLike(raw, p.name, { accent }) || (p.aliases ?? []).some((a) => soundsLike(raw, a, { accent }));
    if (r.kind === "ask" && backed && attention.classify(raw) === null) {
      const said = raw.trim();
      if (alone) {
        showYou(said || "…");
        feedNote(`Knew your voice saying ${p.name}${said ? ` (the words came out as “${said}”)` : ""}.`, p.id);
        lastActivity = Date.now();
        if (p.id !== focusedId) focusOn(p.id);
        else render();
        return;
      }
    }
  }
  // a cough, a laugh, a door: loud and brief, and transcribed as a filler or a stock phrase
  const noise = !typed && isNoise(raw, voicedMs, mustKeep);
  if (noise && raw.trim()) feedNote(`Ignored as noise: “${raw.trim()}”`);
  if (noise) raw = "";
  // you are still talking: wait for the rest. Not over a voice on speakers, though: there the mic
  // never goes quiet, segments are cut short on purpose, and each piece may be the interruption
  const overVoice = !$("phones").checked && voice.speaking;
  if (!typed && hearing && !overVoice) { if (raw) carry = `${carry} ${raw}`.trim(); return; }
  if (!typed && carry) { raw = `${carry} ${raw}`; carry = ""; }
  let text = raw.trim();
  let t = norm(text);
  // Talking over a voice on speakers records both of you: the browser cannot cancel its own speech
  // synthesis. Take its words out and keep yours, so an interruption is never lost in its echo.
  if (!typed && !$("phones").checked && t) {
    const left = voice.withoutEcho(text);
    const l = norm(left);
    if (l && left !== text && (l.split(" ").length >= 2 || mustKeep(l))) {
      feedNote(`Heard you over the voice: “${left}” (its own words taken out)`);
      text = left;
      t = l;
    }
  }
  // nothing, a breath, or a noise
  if (!t || t.length < 2) {
    if ((ducked || continuing) && !userPaused) voice.resume();
    ducked = continuing = false;
    undip();
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
      undip();
      // over a voice, pieces of pure echo arrive every few seconds by design: drop them quietly
      if (!overVoice) {
        showYou(`(heard that as my own echo: ${text}) — say it again and I will take it`);
        feedNote(`Ignored as an echo: “${text}”. Repeat it to override, or turn on headphones.`);
      }
      render();
      return;
    }
  }
  lastIgnored = null;
  lastActivity = Date.now();
  // "Mm-hmm", "right", "okay" while it is still talking: you are listening, not cutting in. It
  // carries on from where it paused. Not when it is waiting on a yes or no, or has just asked you
  // something: then the same word is your answer.
  const midSpeech = !typed && (voice.speaking || voice.held) && (ducked || continuing || dipped || voice.speaking);
  // the sentence it was in the middle of: playing, or held in its place at the front of the queue
  const asked = /\?\s*$/.test(voice.current?.text ?? voice.queue[0]?.text ?? "");
  if (midSpeech && !userPaused && BACKCHANNEL.test(t) && att.mode === "normal" && !asked) {
    showYou(text);
    feedNote(`Heard “${text}” — carried on.`);
    if ((ducked || continuing) && !userPaused) voice.resume();
    ducked = continuing = false;
    undip();
    render();
    return;
  }
  showYou(text);
  // Talking over a voice holds it. Whatever this turns out to be, the hold is let go afterwards —
  // unless it was "pause", or it went to an agent (which clears the voice anyway). Left held, the
  // voice would stay silent for good: nothing queued would ever be said again.
  const heldForYou = ducked || continuing;
  ducked = false;
  const r = route(text, projects, { waiting: attention.order(queue).find((i) => i.kind === "permission")?.project ?? null });
  // a cough the recognizer wrote down as "Bye." must not hang up the call: ending it needs a voice
  if (r.kind === "local" && r.name === "sleep" && !typed && voicedMs < MIN_VOICED_MS) {
    feedNote(`Heard “${text}”, but too briefly to end the call on. Say “bye” again to hang up.`);
    if (heldForYou && !userPaused) voice.resume();
    return;
  }
  const out = act(r, text, typed);
  if (heldForYou && !userPaused && voice.held) voice.resume();
  // your words are in and acted on: a message to an agent has cleared the voice already; a quick
  // command ("status", "pause") leaves it to carry on, at full volume again
  undip();
  return out;
}

// ---------- the assistant working the call: hang up, hold, pause, mute ----------
// Asked by the lead ("Ada, put the call on hold"), done by her once she has finished saying what
// will happen. Each leaves the lead to come back by hand — the mic is off, so they cannot say it.
function afterSpeech(fn, waited = 0) {
  if (voice.idle || waited > 15000) return fn();
  setTimeout(() => afterSpeech(fn, waited + 200), 200);
}
function callControl(what) {
  if (what === "end") return endCall();
  if (!muted) $("muteBtn").click(); // the mic goes off for all three
  if (what === "mute") return;
  voice.hold();
  userPaused = true;
  $("holdText").textContent = what === "hold" ? "The call is on hold. Busy agents keep working." : "The call is paused. Busy agents keep working.";
  $("holdBar").hidden = false;
  render();
}
$("holdResume").onclick = () => {
  $("holdBar").hidden = true;
  if (muted) $("muteBtn").click();
  resumeBuddy();
};

/** A setting changed by the assistant, as if the lead had flipped it in the settings. */
function appSetting(name, value) {
  const on = !/^(off|false|no|0|disable|disabled)$/i.test(String(value));
  const toggles = { chimes: "earcons", earcons: "earcons", ring: "ringToggle", stereo: "stereoToggle", "audio-only": "audioOnly", audio: "audioOnly", cleanup: "refineToggle", refine: "refineToggle" };
  const id = toggles[String(name).toLowerCase()];
  if (id && $(id)) { $(id).checked = on; $(id).dispatchEvent(new Event("change")); return; }
  if (/^hold-?calls$/i.test(name)) return local(on ? "hold" : "unhold");
  feedNote(`${centralName} tried to change "${name}", which is not a setting here.`, centralId, true);
}

// ---------- room for the canvas ----------
// On a wide screen, behind the scenes can fold to a thin rail (its dot shows when something new
// happens there), and the canvas can take most of the screen for a diagram or a long explanation.
function setLayout({ folded = document.body.classList.contains("feed-folded"), wide = document.body.classList.contains("canvas-wide") } = {}) {
  document.body.classList.toggle("feed-folded", folded);
  document.body.classList.toggle("canvas-wide", wide);
  try { localStorage.setItem("layout", JSON.stringify({ folded, wide })); } catch {}
  if (!folded && !wide) $("feedRail").classList.remove("fresh");
}
try { const l = JSON.parse(localStorage.getItem("layout") ?? "{}"); setLayout({ folded: !!l.folded, wide: !!l.wide }); } catch {}
$("foldBtn").onclick = () => setLayout({ folded: true });
$("feedRail").onclick = () => setLayout({ folded: false, wide: false });
$("wideBtn").onclick = () => setLayout({ wide: !document.body.classList.contains("canvas-wide") });

// ---------- away from the tab ----------
// With the page in the background (another app, a locked phone), a request or a question also
// shows as a system notification, so it is not missed; tapping it brings the lead to that agent.
function notifyAway(item) {
  if (!document.hidden || typeof Notification === "undefined" || Notification.permission !== "granted") return;
  if (!["permission", "question", "failed"].includes(item.kind)) return;
  try {
    const n = new Notification(`${item.name} ${item.kind === "question" ? "has a question" : item.kind === "failed" ? "hit a problem" : "needs your yes"}`, {
      body: item.text.replace(new RegExp(`^${item.name}( asks:)? `), ""),
      tag: `cc-${item.uid}`,
      requireInteraction: item.kind === "permission",
    });
    n.onclick = () => { window.focus(); focusOn(item.project); n.close(); };
  } catch {}
}
/** Asked once, inside the click that starts a call: browsers only allow it from a gesture. */
function askToNotify() {
  try { if (typeof Notification !== "undefined" && Notification.permission === "default") Notification.requestPermission(); } catch {}
}

// Headphone and keyboard media keys: play/pause pauses or resumes the voice, "next" goes through
// who is waiting, "previous" repeats the last thing said. Hands-free from AirPods.
function mediaKeys() {
  const ms = navigator.mediaSession;
  if (!ms) return;
  const on = (action, fn) => { try { ms.setActionHandler(action, fn); } catch {} };
  on("play", () => resumeBuddy());
  on("pause", () => pauseBuddy());
  on("nexttrack", () => local("next"));
  on("previoustrack", () => local("repeat"));
  on("stop", () => endCall("Bye for now. Press call when you need me."));
  try { ms.metadata = new MediaMetadata({ title: "ClaudeCall", artist: `Talking with ${nameOf(focusedId) || centralName}` }); } catch {}
}

// ---------- voices placed in space ----------
// On a Mac the server makes each sentence as audio in the agent's own system voice, and the page
// plays it from that agent's side (see stereo.js). Off, or anywhere else, the browser speaks.
let ttsCapable = false;
let ttsSeq = 0;
const ttsWaiting = new Map(); // request id -> { resolve, reject }
function fetchSpeech(text, identity) {
  return new Promise((resolve, reject) => {
    const id = `t${++ttsSeq}`;
    const timer = setTimeout(() => { ttsWaiting.delete(id); reject(new Error("slow")); }, 8000);
    ttsWaiting.set(id, {
      resolve: (b64) => { clearTimeout(timer); const bin = atob(b64), buf = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) buf[i] = bin.charCodeAt(i); resolve(buf.buffer); },
      reject: (e) => { clearTimeout(timer); reject(e); },
    });
    if (!send({ type: "tts", id, text, voices: identity?.voices ?? [], rate: identity?.rate ?? 1 })) { ttsWaiting.delete(id); clearTimeout(timer); reject(new Error("offline")); }
  });
}
function useStereo() {
  const on = ttsCapable && $("stereoToggle").checked && !!audioCtx;
  voice.engine = on ? (voice.engine ?? new StereoEngine({ ctx: audioCtx, fetchAudio: fetchSpeech })) : null;
}
try { $("stereoToggle").checked = localStorage.getItem("stereo") !== "0"; } catch {}
$("stereoToggle").onchange = () => { try { localStorage.setItem("stereo", $("stereoToggle").checked ? "1" : "0"); } catch {} useStereo(); };

// ---------- while you were away ----------
// A call left running when the lead hung up, with the team still busy. On rejoining, Ada says in a
// sentence what happened meanwhile; the details wait in the queue, to hear with "next" as usual.
let replaying = false; // the news being replayed is not rung for, item by item
const listNames = (ns) => (ns.length < 2 ? ns.join("") : `${ns.slice(0, -1).join(", ")} and ${ns[ns.length - 1]}`);
function briefing(m) {
  greetPending = false;
  quietly(centralId); // the briefing is the greeting: no "back with me" on top of it
  replaying = true;
  setTimeout(() => { replaying = false; }, 1500);
  const mins = Math.max(1, Math.round((Date.now() - m.since) / 60000));
  const news = m.news ?? [];
  const names = (kinds) => [...new Set(news.filter((n) => kinds.includes(n.kind)).map((n) => n.name))];
  const done = names(["finished"]), failed = names(["failed", "blocked"]);
  // her own requests, in her own words: "I need your answer", not "Ada is waiting on you"
  const waiting = names(["permission", "question"]).filter((n) => n !== centralName);
  const mineWaiting = news.some((n) => n.name === centralName && (n.kind === "permission" || n.kind === "question"));
  const bits = [];
  if (done.length) bits.push(`${listNames(done)} finished`);
  if (failed.length) bits.push(`${listNames(failed)} hit a problem`);
  if (waiting.length) bits.push(`${listNames(waiting)} ${waiting.length > 1 ? "are" : "is"} waiting on you`);
  if (mineWaiting) bits.push("I need your answer on something");
  central.say(bits.length
    ? `Welcome back. In the ${mins} minute${mins > 1 ? "s" : ""} you were away, ${bits.join(", ")}. Say next to go through it.`
    : `Welcome back. Nothing new in the ${mins} minute${mins > 1 ? "s" : ""} you were away; the team is still at work.`);
  if (news.length) earcons.ring();
}

// ---------- undo ----------
// Undoing an agent's last turn is asked first: Ada says what it would put back, and only "confirm"
// (or "yes") within a few seconds does it. Rolling back work should never happen on a stray word.
let pendingUndo = null; // { project, until }
function askUndo(id) {
  if (!id) return central.say("Whose work should I undo? Say undo, and the name.");
  send({ type: "undo", project: id, dry: true });
}
function undoPreview(m) {
  const name = nameOf(m.project);
  if (m.files == null) return central.say(`There's nothing to undo for ${name}: undo works in folders that use git, from ${name}'s next piece of work on.`);
  if (!m.files.length) return central.say(`${name} hasn't changed any files since then, so there's nothing to undo.`);
  const shown = m.files.length <= 3 ? m.files.map((f) => f.split("/").pop()).join(", ") : `${m.files.length} files`;
  pendingUndo = { project: m.project, until: Date.now() + 15_000 };
  central.say(`Undo ${name}'s last piece of work? It would put back ${shown}. Say confirm to undo, or no.`);
  feedNote(`Undo ${name}'s last piece of work ("${m.label}")? Files that would go back: ${m.files.join(", ")}. Say confirm.`, m.project);
}

/** Carry out what was said, once it is known to be the lead's own words and not noise or echo. */
let lastHeard = ""; // the words being handled, for commands that turn out to be an answer
function act(r, text, typed) {
  lastHeard = text;
  if (pendingUndo) {
    const word = attention.classify(text);
    if (pendingUndo.until > Date.now() && (word === "confirm" || word === "yes")) {
      send({ type: "undo", project: pendingUndo.project });
      pendingUndo = null;
      return;
    }
    if (word === "no" || word === "later") { pendingUndo = null; return void central.say("Okay, left as it is."); }
    pendingUndo = null;
  }
  // The assistant just asked something. A short reply is the answer to it; so is anything said
  // in reply to a question she read out. A command or a name goes where it always goes.
  // Outside a window this still matters: a yes a moment after a heads-up answers it.
  if (r.kind === "ask" || attention.classify(text) !== null) {
    if (!obey(attention.heard(att, text, queue, Date.now()))) return;
  } else if (att.mode !== "normal") att = { ...att, mode: "normal", item: null };

  if (continuing) {
    continuing = false;
    // the rest of a sentence goes where its first half went, not to whoever has the line now
    if (!typed && lastAsk && r.kind === "ask") return ask(`${lastAsk.text} ${text}`, `${lastAsk.text} ${text}`, { merge: true, project: lastAsk.project });
    if (!userPaused) voice.resume();
  }

  switch (r.kind) {
    case "local": return local(r.name);
    case "focus": return focusOn(r.project);
    case "handoff":
      // put through with a note: the one receiving you greets you and checks, the page stays quiet
      quietly(r.project);
      voice.clear();
      return send({ type: "handoff", from: focusedId ?? centralId, to: r.project, text: r.text });
    case "address": {
      const c = r.text && controlOf(r.text);
      if (c) return runControl(r.project, c.what, c.value ?? "");
      return r.text ? ask(r.text, text, { project: r.project }) : focusOn(r.project);
    }
    case "control": return runControl(focusedId ?? centralId, r.what, r.value ?? "");
    case "tell":
      send({ type: "tell", project: r.project, text: r.text });
      for (const i of queue.slice()) if (i.project === r.project && i.kind === "question") removeItem(i);
      central.passedOn(nameOf(r.project));
      return;
    case "grant": {
      const item = queue.find((i) => i.project === r.project && i.kind === "permission");
      // something that cannot be undone is not granted on "allow Rex": Ada asks for "confirm"
      if (item?.risk) return void obey(attention.confirmFirst(att, item, Date.now()));
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
    case "stop-agent":
      send({ type: "interrupt", project: r.project });
      central.say(`Stopped ${nameOf(r.project)}.`);
      return;
    case "undo": return askUndo(r.project ?? (focusedId !== centralId ? focusedId : null));
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
    // "go ahead", "carry on": resume a paused voice — or, if nothing is paused, it is an answer
    case "resume": if (userPaused || voice.held) return resumeBuddy(); return ask(lastHeard, lastHeard);
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
    case "sleep": {
      // whoever is still at work carries on after the call ends, and the lead hears about it later
      const busy = team().filter((p) => p.state === "working").map((p) => p.name);
      return endCall(busy.length ? `Bye for now. ${listNames(busy)} will keep working, and I'll fill you in when you're back.` : "Bye for now. Press call when you need me.");
    }
    // finished with an agent: the floor goes back to the assistant, who is listening at once
    // done with an agent: to the assistant. Done with her, after a detour: back where you were
    case "done":
      if (focusedId && focusedId !== centralId) return focusOn(centralId);
      if (cameFrom && project(cameFrom)) return focusOn(cameFrom);
      return;
    // back from a detour to the assistant; from an agent, back to her
    case "back":
      if (focusedId !== centralId) return focusOn(centralId);
      if (cameFrom && project(cameFrom)) return focusOn(cameFrom);
      return central.say("There's no one to go back to yet. Say a name.");
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
    case "teach": {
      // "teach Ada", "learn how I say Juno": that one name; otherwise the ones not learned yet,
      // or everyone's if all are known
      const named = projects.find((p) => new RegExp(`\\b${norm(p.name)}\\b`).test(norm(lastHeard)));
      if (named) return openTeach(named.id);
      const ids = untaught();
      return teachAll(ids.length ? ids : projects.map((p) => p.id));
    }
    case "more": return more();
    case "repeat": {
      voice.clear();
      userPaused = false;
      const lines = voice.heard.length ? voice.heard : voice.lastTurnSpoken;
      for (const s of lines.slice()) voice.say(s, currentTurn, { record: false, keep: true, identity: identityOf(focusedId), speaker: focusedId ?? centralId });
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
  // Talking to an agent that is busy: a side question (Claude Code's /btw). It is answered in a
  // second or two while the work carries on; if it is really new work, the agent says it will do
  // it next and it is queued. Either way, nothing waits behind a long task in silence.
  const target = pid ?? focusedId;
  // busy means busy for whoever it is for: "Rex, also add tests" while talking to Juno must not
  // cut Rex's running work off either
  const busy = target === focusedId ? working : project(target)?.state === "working";
  // Ada is cut off for real: whatever tags she had written still happen, one she was in the middle
  // of is reported back to her, so nothing is lost (server: noteCutOff). A project agent at work is
  // not: what you say goes in beside the work as a side question, and the work carries on.
  const sideQuestion = busy && !merge && target !== centralId;
  if (sideQuestion) {
    // what you had heard of its reply when you spoke: if it was talking rather than running a
    // command, the server cuts in for real, and the agent picks up from exactly there
    let cut = null;
    if (target === focusedId && voice.busy) {
      voice.hold();
      const snap = voice.snapshot();
      cut = { kind: "interrupted", heard: snap.heard, unheard: snap.unheard, working: true };
    }
    voice.clear();
    userPaused = false;
    lastAsk = { text: prompt, at: Date.now(), btw: true, project: target };
    send({ type: "btw", project: target, text: prompt, context: cut });
    showYou(shown);
    render();
    return;
  }
  let context = null;
  // Talking never kills work. If the agent on the line is busy, what you said waits behind it,
  // and the work's own report still plays when it lands. Only "stop" cuts work off.
  // A merged sentence whose first half was queued stays queued, replacing that half.
  const queued = merge ? !!lastAsk?.queued : busy && target !== centralId;
  if (merge && currentTurn > 0 && target === focusedId) {
    // replace the turn we just sent rather than cutting in on it: it was your own half-sentence
    dropped.add(key(target, currentTurn));
    liveTurns.delete(currentTurn);
    cards.get(key(target, currentTurn))?.el.remove();
    cards.delete(key(target, currentTurn));
    if (queued) context = { kind: "followup", working: true, queued: true, replace: true };
  } else if (target === focusedId && (voice.busy || working || userPaused)) {
    // what the lead heard and missed is only news to the agent they were listening to
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
  lastAsk = { text: prompt, at: Date.now(), queued, project: target };
  spokeThisTurn = false;
  if (!queued) {
    currentTurn = -1; // ignore the old turn's tail until the server names the new one
    liveTurns.clear();
  }
  // spoken words get the clean-up pass on the server; typed ones are already what was meant
  send({ type: "utterance", project: target, text: prompt, context, mode: mode(), typed: inputTyped || undefined, refine: $("refineToggle").checked, canvas: canvasSize() });
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
  showIcon($("callBtn"), "phoneOff", 26);
  $("callBtn").title = "End the call";
  for (const id of ["muteBtn", "pauseBtn", "typeBox"]) $(id).disabled = false;
  // a fresh team is coming; greet from it, not from the last call's
  rosterSeen = false;
  greetPending = true;
  nudged = false;
  att = attention.createAttention();
  send({ type: "call-start", mode: mode() });
  // Safari only allows audio and speech that start inside the click, so do both before any await
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume?.();
  earcons.ctx = audioCtx;
  useStereo(); // the audio engine needs the context made inside this click
  askToNotify();
  mediaKeys();
  voice.unlock();
  central.hello();
  await openListener();
  audioCtx.onstatechange = () => { if (audioCtx.state !== "running") setTimeout(keepHearing, 300); };
  if (!muted) startListening();
  clearInterval(sleepTimer);
  sleepTimer = setInterval(tick, 1000);
  render();
}

/** The microphone and the voice detector on it (or, failing that, the browser's own recognition). */
async function openListener() {
  try {
    listener ??= await createVadListener({
      audioContext: audioCtx,
      onSpeechStart,
      onMisfire: () => {
        hearing = false;
        undip();
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
      onLevel: (p) => { callEl.style.setProperty("--level", p.toFixed(2)); bargeFrame(p); },
      processorType: new URLSearchParams(location.search).get("processor") === "script" ? "ScriptProcessor" : "auto",
    });
  } catch (err) {
    console.warn("VAD unavailable, using browser recognition", err);
    feedNote(`Using the browser's speech recognition instead (${err.message}).`);
    try {
      listener ??= createChromeListener({ onSpeechStart, onText: (t) => { hearing = false; heardText(t); } });
    } catch (e2) {
      feedError(focusedId, 0, `ClaudeCall cannot hear on this browser: ${e2.message}. You can still type.`);
    }
  }
}

function endCall(message) {
  if (!onCall) return;
  onCall = false;
  // an update arrived during the call: take it now that the call is over
  if (updatePending) setTimeout(() => location.reload(), 1500);
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
  focusedId = confirmedFocus = wantFocus = null;
  activity.clear();
  pipeline.clear();
  $("callBtn").classList.remove("end");
  showIcon($("callBtn"), "phone", 26);
  $("callBtn").title = "Start the call";
  for (const id of ["muteBtn", "pauseBtn", "typeBox"]) $(id).disabled = true;
  $("timer").textContent = "call ended";
  if (message) central.say(message);
  render();
}

// Talking over the voice for real, not a breath or its own echo: speech that keeps going after
// the voice has dropped away (its echo all but gone with it) pauses the voice where it is. If the
// words turn out to be nothing, or a quick "mm-hmm", it carries on from that very word.
const BARGE_FRAMES = 20; // ~640 ms of steady speech
let bargeVoiced = 0;
function bargeFrame(p) {
  if (!dipped || !voice.speaking || userPaused) { bargeVoiced = 0; return; }
  bargeVoiced = p >= 0.5 ? bargeVoiced + 1 : Math.max(0, bargeVoiced - 1);
  if (bargeVoiced >= BARGE_FRAMES) {
    bargeVoiced = 0;
    ducked = true; // the hold is let go again by heardText if this was nothing
    voice.hold();
    render();
  }
}

let dipped = false, dipTimer = 0;
/** A listener's acknowledgement, not an interruption. Whole utterance only. */
const BACKCHANNEL = /^(?:yeah|yep|yes|ok|okay|mm+|mhm+|mm hmm|mhmm|uh huh|uh-huh|right|sure|got it|i see|cool|nice|great|alright|all right|true|exactly|makes sense|go on|carry on|continue)$/;

/** Back to full volume: what started over the voice was noise, or its own echo. */
function undip() {
  clearTimeout(dipTimer);
  if (dipped) { dipped = false; voice.duck(false); }
}

function onSpeechStart() {
  if (!onCall || muted) return;
  bargeVoiced = 0;
  hearing = true;
  lastActivity = Date.now();
  // hold (not drop) the reply: if this turns out to be noise it plays on, if it is more of your sentence it is replaced
  if (lastAsk && !lastAsk.btw && Date.now() - lastAsk.at < MERGE_MS && !spokeThisTurn) { continuing = true; voice.hold(); }
  showYou("…", true);
  // with headphones the voice cannot reach the mic, so cut it off the moment you speak
  if ($("phones").checked && voice.speaking && !userPaused) { ducked = true; voice.hold(); }
  // On speakers it might be the voice's own echo, so it is not cut yet: it drops right down, at
  // once — you hear it give way — and stops as soon as your words show it was you (heardText).
  else if (voice.speaking && !userPaused) {
    dipped = true;
    voice.duck(true);
    clearTimeout(dipTimer);
    dipTimer = setTimeout(undip, 8000); // nothing came of it: back up
  }
  render();
}

function transcribe(pcm, voicedMs) {
  const id = String(++segSeq);
  showYou("…", true);
  pendingSegments.set(id, (text, match) => heardText(text, { voicedMs, match }));
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
  // only the assistant's own voice keeps her window open: an agent talking at length must not
  // stretch it, or the lead's next words to that agent would be taken as an answer to her
  att = attention.tick(att, now, { speaking: !voice.idle && talkingId === centralId, hearing });
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

// ---------- is it a good name to call out loud? ----------
// As a name is typed, a quick read of how easy it will be to pick out (namecheck.js), and a button
// to really test it: said in several voices with real-world drift, through the app's recogniser.
// Advice only — a weak name is allowed; the lead decides.
const nameTests = new Map(); // name -> result, so the same name is not tested twice
function nameAdvice(el, name, except = null) {
  const n = name.trim();
  if (!n || !/^[A-Za-z][A-Za-z']{1,19}$/.test(n)) { el.innerHTML = ""; el.className = "advice"; return; }
  const others = projects.filter((p) => p.id !== except).map((p) => p.name);
  const r = rateName(n, others);
  const label = { good: "Easy to call", okay: "Usually fine", weak: "Hard to hear" }[r.verdict];
  el.className = `advice ${r.verdict}`;
  const tested = nameTests.get(n.toLowerCase());
  el.innerHTML = `<span class="badge2">${label}</span>${esc(r.reasons[0] ?? "")}${r.reasons[1] && r.verdict === "weak" ? ` ${esc(r.reasons.at(-1))}` : ""}`
    + (ttsCapable ? `<button type="button" data-test>${tested ? "Test again" : "Test how it's heard"}</button>` : "")
    + (tested ? `<span class="heard">${testLine(n, tested)}</span>` : "")
    // a weak name gets a few strong ones to pick instead, one click to try
    + (r.verdict === "weak" ? `<span class="heard">Try ${suggestNames(others).map((x) => `<button type="button" data-name="${x}">${x}</button>`).join("")}</span>` : "");
  for (const nb of el.querySelectorAll("[data-name]")) nb.onclick = () => {
    const input = el.closest("label, form, dialog")?.querySelector("input[name=name], #renameBox");
    if (input) { input.value = nb.dataset.name; input.dispatchEvent(new Event("input", { bubbles: true })); input.focus(); }
  };
  const b = el.querySelector("[data-test]");
  if (b) b.onclick = () => {
    b.disabled = true;
    b.textContent = "Saying it in a few voices…";
    pendingNameTest = { el, name: n, except };
    send({ type: "name-test", name: n, others });
  };
}
let pendingNameTest = null;
function testLine(n, t) {
  if (t.error) return `Could not test it: ${esc(t.error)}.`;
  const pct = Math.round((100 * t.heard) / Math.max(1, t.total));
  const how = pct >= 90 ? "came through nearly every time" : pct >= 70 ? "came through most of the time" : "was often misheard";
  return `Said ${t.total} ways, “${esc(n)}” ${how} (${t.heard} of ${t.total})${t.takenFor ? `, and was taken for ${esc(t.takenFor)}` : ""}${t.misheard?.length && pct < 90 ? `; heard as ${t.misheard.slice(0, 2).map((m) => `“${esc(m)}”`).join(", ")}` : ""}.`;
}
function nameTested(m) {
  nameTests.set(String(m.name).toLowerCase(), m);
  if (pendingNameTest?.name === m.name) nameAdvice(pendingNameTest.el, m.name, pendingNameTest.except);
}

/** Why a name would be hard to use on this call, or "" when it is fine. Checked again on the server. */
function nameWarning(name, except = null) {
  const n = name.trim();
  if (!n) return "";
  if (!/^[A-Za-z][A-Za-z']{1,19}$/.test(n)) return "One word, letters only, easy to say.";
  const others = projects.filter((p) => p.id !== except).map((p) => p.name);
  const taken = others.find((o) => o.toLowerCase() === n.toLowerCase());
  if (taken) return `${taken} is already on the call.`;
  const clash = confusable(n, others);
  return clash ? `Sounds too much like ${clash}: the two would be hard to tell apart by voice.` : "";
}

// renaming: a small dialog, checked as you type and again on the server; a new name is followed
// at once by teaching how you say it
let renaming = null; // id being renamed, while the server decides
function renameAgent(id) {
  renaming = null;
  $("renameWho").textContent = nameOf(id);
  $("renameFace").innerHTML = face(id);
  $("renameFace").style.setProperty("--hue", String(identityOf(id)?.hue ?? 18));
  const box = $("renameBox");
  box.value = nameOf(id);
  box.dataset.id = id;
  $("renameNote").textContent = "";
  $("renameGo").disabled = true;
  $("renameDlg").showModal();
  // how the current name fares, before anything is typed: the reason to rename, or not
  nameAdvice($("renameAdvice"), nameOf(id), id);
  box.select();
}
$("renameBox").addEventListener("input", (e) => {
  const v = e.target.value.trim(), id = e.target.dataset.id;
  nameAdvice($("renameAdvice"), v, id);
  const warn = v.toLowerCase() === nameOf(id).toLowerCase() ? "" : nameWarning(v, id);
  $("renameNote").textContent = warn;
  $("renameGo").disabled = !v || !!warn || v.toLowerCase() === nameOf(id).toLowerCase();
});
$("renameForm").addEventListener("submit", (e) => {
  e.preventDefault();
  const id = $("renameBox").dataset.id, v = $("renameBox").value.trim();
  if (!v || nameWarning(v, id)) return;
  renaming = id;
  $("renameGo").disabled = true;
  $("renameNote").textContent = "Renaming…";
  send({ type: "rename", project: id, name: v });
  // no answer means no server to ask: say so rather than look stuck
  setTimeout(() => { if (renaming === id) renameRefused("No answer from ClaudeCall. Is it still running?"); }, 6000);
});
$("renameCancel").onclick = () => { renaming = null; $("renameDlg").close(); };
function renameRefused(text) {
  renaming = null;
  $("renameNote").textContent = text;
  $("renameGo").disabled = false;
}
function renamed(id, name) {
  const asked = renaming === id;
  renaming = null;
  if ($("renameDlg").open) $("renameDlg").close();
  if (id === centralId) { centralName = name; central.setIdentity(null, centralId, name); }
  render();
  if (asked || !teach) openTeach(id, name);
}

// ---------- teaching how you say a name ----------
// After a rename, or whenever asked, the lead says the name until ClaudeCall is confident of it.
// Two things are learned from each try: its sound, compared later by the server against anything
// short the lead says, and the recognizer's spelling of it, kept as an alias. The server judges
// every try (kept, or dropped as not like the others) and says when it is confident. A run over
// the whole team leaves a pause between names, with nothing recorded, so one name never spills
// into the next.
let teach = null; // { id, name, phase: "listen" | "done" | "gap", heard: [{ text, form, clash, status }], progress, gapLeft }
let voiceCounts = {}; // agent id -> samples of the lead's voice the server holds
let voiceConfident = new Set(); // agents whose name was learned to confidence
let teachQueue = []; // the rest of a "teach everyone's name" run
let teachTotal = 0;
let teachTimers = [];
let nudged = false; // the offer to teach names is made once a call, at most
const GAP_MS = 2500;
const PROMPTS = ["Say it on its own, the way you'll say it on calls.", "Again.", "Once more.", "One more time, a little slower.", "Again, as you'd say it mid-sentence.", "Nearly there. Once more.", "Again, please.", "One last time."];

/** Teach every name in turn: the assistant first, then the team. */
function teachAll(ids = projects.map((p) => p.id)) {
  teachQueue = [...ids];
  teachTotal = teachQueue.length;
  $("teachNudge").hidden = true;
  const first = teachQueue.shift();
  if (first) openTeach(first);
}
/** Names not yet learned to confidence: worth teaching before they cause a misroute. */
const untaught = () => projects.filter((p) => !voiceConfident.has(p.id)).map((p) => p.id);
function maybeNudgeTeach() {
  // an offer already on screen is kept true to the team as it changes: names learned since leave
  // it, a newly seated agent joins it, and it goes once every name is known
  if (!$("teachNudge").hidden) {
    const left = untaught();
    if (!left.length || teach) { $("teachNudge").hidden = true; return; }
    $("teachNudgeText").textContent = nudgeText(left);
    return;
  }
  if (!onCall || nudged || teach || !projects.length) return;
  const ids = untaught();
  if (!ids.length) return;
  nudged = true;
  $("teachNudgeText").textContent = nudgeText(ids);
  $("teachNudge").hidden = false;
}
let relearn = new Set(); // names taught before name learning was rebuilt: their old samples no longer apply
function nudgeText(ids) {
  if (ids.some((id) => relearn.has(id))) return `Name learning has been rebuilt to cope with accents and real rooms, so ${ids.length === 1 ? `${nameOf(ids[0])} needs` : `${ids.length} names need`} teaching once more. Three tries each.`;
  return ids.length === projects.length
    ? `ClaudeCall picks out names far better once it has heard your voice say them. Teach ${ids.length === 1 ? "the name" : `all ${ids.length} names`} now? Under a minute.`
    : `${ids.map(nameOf).join(", ")} ${ids.length === 1 ? "is" : "are"} not learned well yet. Teach ${ids.length === 1 ? "it" : "them"} now?`;
}
const later = (fn, ms) => teachTimers.push(setTimeout(fn, ms));
const clearTeachTimers = () => { teachTimers.forEach(clearTimeout); teachTimers = []; };

function openTeach(id, name = nameOf(id)) {
  clearTeachTimers();
  teach = { id, name, phase: "listen", heard: [], progress: null };
  voice.clear();
  voice.hold();
  if (!$("teachDlg").open) $("teachDlg").showModal();
  drawTeach();
  // the agent's own chime says "your turn"; recording starts just after it, so it is not a try
  if (earcons.enabled) earcons.play(identityOf(id)).catch(() => {});
  later(() => { if (teach?.id === id) send({ type: "teach-start", project: id }); }, 420);
}
/** Save what this name's tries taught, then go on to the next name or finish. */
function finishName(save) {
  if (!teach || teach.phase !== "listen") return;
  const t = teach;
  t.phase = "done";
  const kept = t.heard.filter((h) => h.status === "kept");
  const forms = kept.filter((h) => h.form && !h.clash && h.form !== t.name.toLowerCase()).map((h) => h.form);
  if (save && forms.length) send({ type: "teach", project: t.id, heard: forms });
  send({ type: "teach-end", project: t.id, save: save && kept.length > 0 });
  drawTeach();
  later(nextName, save ? 1100 : 300);
}
function nextName() {
  const next = teachQueue.shift();
  // the last name: the dialog stays, showing how it went, with "teach it again" — a stubborn name
  // often wants a second round, and a dialog that vanishes on its own leaves no way to give it one
  if (!next || !project(next)) { if (teach) { teach.phase = "done"; drawTeach(); } return; }
  // a pause with nothing recorded, so the last name never spills into this one
  teach = { id: next, name: nameOf(next), phase: "gap", heard: [], progress: null, gapLeft: Math.ceil(GAP_MS / 1000) };
  drawTeach();
  for (let i = 1; i <= Math.ceil(GAP_MS / 1000); i++) later(() => { if (teach?.phase === "gap") { teach.gapLeft--; drawTeach(); } }, (GAP_MS / Math.ceil(GAP_MS / 1000)) * i - 50);
  later(() => openTeach(next), GAP_MS);
}
function endTeach({ stopRun = false } = {}) {
  clearTeachTimers();
  setTimeout(maybeNudgeTeach, 0); // the offer, if still up, reflects what is now learned
  if (teach?.phase === "listen") send({ type: "teach-end", project: teach.id, save: false });
  if (stopRun) teachQueue = [];
  teach = null;
  if ($("teachDlg").open) $("teachDlg").close();
  if (!userPaused) voice.resume();
}
function teachHeard(raw) {
  if (!teach || teach.phase !== "listen") return; // between names nothing counts
  const text = raw.trim();
  // a few words steer the session hands-free; anything else is a try at the name
  const w = norm(text);
  if (/^(skip|skip it|skip this one|next|next one|next name)$/.test(w)) return teachSkip();
  if (/^(stop|cancel|stop teaching|stop learning|that'?s enough|enough|never mind)$/.test(w)) return endTeach({ stopRun: true });
  if (/^(done|i'?m done|that'?s it|finish|finished|save it)$/.test(w) && teach.heard.some((h) => h.status === "kept")) return finishName(true);
  const form = text ? spokenName(text) : "";
  // a spelling that is someone else's name would send the lead to them: that spelling is not kept
  const other = form ? projects.find((p) => p.id !== teach.id && (p.name.toLowerCase() === form || (p.aliases ?? []).includes(form))) : null;
  const clash = !form ? "" : other ? other.name : confusable(form, projects.filter((p) => p.id !== teach.id).map((p) => p.name)) ?? "";
  teach.heard.push({ text, form, clash, status: "pending" });
  drawTeach();
}
/** The server's verdict on the latest try. */
function teachProgress(m) {
  if (!teach || teach.phase !== "listen" || m.project !== teach.id) return;
  teach.progress = m;
  const last = [...teach.heard].reverse().find((h) => h.status === "pending");
  if (last) last.status = m.outlier ? (m.tooLong ? "long" : "dropped") : "kept";
  // a sound for every verdict, so the lead can teach without watching the screen
  earcons.cue(m.confident ? "learned" : m.outlier ? "dropped" : "kept");
  drawTeach();
  if (m.done) later(() => finishName(true), 500);
}
function drawTeach() {
  if (!teach) return;
  const t = teach, p = t.progress;
  const gap = t.phase === "gap";
  $("teachStep").textContent = teachTotal > 1 ? `${teachTotal - teachQueue.length} of ${teachTotal}` : "";
  $("teachFace").innerHTML = face(t.id);
  $("teachFace").style.setProperty("--hue", String(identityOf(t.id)?.hue ?? 18));
  $("teachTitle").innerHTML = gap ? `Next: “${esc(t.name)}”` : t.phase === "done" ? (p?.confident ? `Got “${esc(t.name)}”` : `Saved what was heard for “${esc(t.name)}”`) : `How do you say “${esc(t.name)}”?`;
  const lastStatus = [...t.heard].reverse().find((h) => h.status !== "pending")?.status;
  $("teachHint").textContent = !onCall ? "Start the call so the mic is on, then say the name."
    : gap ? `Get ready… ${Math.max(1, t.gapLeft)}`
    : t.phase === "done" ? (p?.confident ? (p.clash ? `Learned. In your voice it sounds a lot like ${nameOf(p.clash)}: if the two get mixed up, renaming one will help.` : "Learned.") : "Not fully sure yet: you can teach it again any time from the 🎤 button.")
    : lastStatus === "dropped" ? `That didn't sound like the others. Say “${t.name}” again.`
    : lastStatus === "long" ? `That was more than the name. Just “${t.name}”.`
    : p?.confident ? `Learned, ${Math.round((p.confidence ?? 0) * 100)}% sure. A few more tries make it surer, or say “done”.`
    : p?.clash ? `In your voice that sounds a lot like ${nameOf(p.clash)}. Say “${t.name}” clearly once more.`
    : PROMPTS[Math.min(t.heard.length, PROMPTS.length - 1)];
  const q = gap ? 0 : Math.round((p?.quality ?? 0) * 100);
  $("teachDots").innerHTML = gap ? `<div class="tcount">${Math.max(1, t.gapLeft)}</div>` : `<div class="tbar${p?.confident ? " done" : ""}"><i style="width:${q}%"></i></div><small>${p ? `${Math.round((p.confidence ?? p.quality ?? 0) * 100)}% sure · ${p.kept} kept${p.attempt ? ` of ${p.attempt} tries` : ""}${p.heardName ? ` · heard as “${esc(t.name)}” ${p.heardName}×` : ""}` : "listening…"}</small>`;
  $("teachDots").classList.toggle("listening", t.phase === "listen" && onCall);
  $("teachHeard").innerHTML = gap ? "" : t.heard.slice(-5).map((h) => `<li class="${h.status === "kept" ? "ok" : h.status === "pending" ? "" : "warn"}"><b>${h.text ? `“${esc(h.text)}”` : "Your voice"}</b><span>${
    h.status === "pending" ? "checking…"
    : h.status === "dropped" ? "didn't match the others, not kept"
    : h.status === "long" ? "more than the name, not kept"
    : h.clash ? `kept; the spelling sounds like ${esc(h.clash)}, so only the sound is used`
    : h.form && h.form !== t.name.toLowerCase() ? `kept; it will also answer to “${esc(h.form)}”` : "kept"}</span></li>`).join("");
  $("teachStart").hidden = onCall;
  $("teachDone").disabled = gap || t.phase !== "listen" || !t.heard.some((h) => h.status === "kept");
  const finished = t.phase === "done" && !teachQueue.length;
  $("teachAgain").hidden = gap || (!t.heard.length && !finished);
  $("teachAgain").textContent = finished ? "Teach it again" : "Start over";
  $("teachStop").hidden = !teachQueue.length && !gap;
  $("teachSkip").textContent = finished ? "Close" : teachQueue.length || gap ? "Skip this one" : "Skip";
}
function taught(m) {
  if (m.kept?.length) feedNote(`${nameOf(m.project)} will also answer to ${m.kept.map((k) => `“${k}”`).join(", ")}.`, m.project);
}
$("teachDone").onclick = () => finishName(true);
$("teachNudgeGo").onclick = () => teachAll(untaught());
$("teachNudgeLater").onclick = () => ($("teachNudge").hidden = true);
$("teachAllBtn").onclick = () => teachAll();
$("teachAgain").onclick = () => {
  if (!teach) return;
  // after a finished round, another round on the same name: its new tries join what it knows
  if (teach.phase === "done") return openTeach(teach.id, teach.name);
  if (teach.phase !== "listen") return;
  teach.heard = []; teach.progress = null; send({ type: "teach-start", project: teach.id }); drawTeach();
};
$("teachSkip").onclick = () => teachSkip();
function teachSkip() {
  if (!teach) return;
  if (teach.phase === "done" && !teachQueue.length) return endTeach(); // "Close"
  if (teach.phase === "gap") { clearTeachTimers(); return nextName(); } // skip the name that was coming up
  if (teach.phase === "listen") finishName(false);
}
$("teachStop").onclick = () => endTeach({ stopRun: true });
$("teachStart").onclick = () => { startCall(); setTimeout(drawTeach, 300); };
$("teachDlg").addEventListener("cancel", (e) => { e.preventDefault(); endTeach({ stopRun: true }); });

// ---------- new agent ----------
// Name, the folder it works in (chosen in the lead's own file manager), and optionally its own
// instructions and a first task. Exact, so it goes straight to the server with no model involved.
function openNewProject() {
  if (!onCall) return;
  $("newDlg").returnValue = ""; // Esc after an earlier "Seat it" must not seat another
  $("nameAdvice").innerHTML = "";
  $("newForm").reset();
  fillModels($("newForm").elements.model);
  $("pickNote").textContent = "";
  $("nameNote").textContent = "";
  $("newDlg").showModal();
}
$("newForm").elements.name.addEventListener("input", (e) => {
  nameAdvice($("nameAdvice"), e.target.value);
  const warn = nameWarning(e.target.value);
  $("nameNote").textContent = warn;
  e.target.setCustomValidity(warn);
});
// Cancel is a plain button, not the form's first submit button: Enter in a field must seat the agent
$("newCancel").onclick = () => $("newDlg").close("cancel");
// the chooser opens on the computer running ClaudeCall: from a phone or tablet it would pop up out of
// reach, so there the path is typed instead
const onThisComputer = /^(localhost|127\.0\.0\.1|\[::1\])$/.test(location.hostname);
$("browseBtn").hidden = !onThisComputer;
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
  const m = { type: "create", name, prompt: String(f.get("prompt") ?? "").trim(), brief: String(f.get("brief") ?? "").trim(), focus: !!f.get("focus"), model: String(f.get("model") ?? "") };
  // no folder given: a new one in the assistant's home, named after the agent
  if (path) m.path = path;
  else m.folder = name.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (!name) return;
  send(m);
  feedNote(`Seating ${name}${path ? ` in ${tilde(path)}` : ""}…`);
});

// ---------- controls ----------
$("callBtn").onclick = () => (onCall ? endCall() : startCall());
/**
 * "Are you sure?" in the page. Not the browser's confirm(): that freezes the page while it is open,
 * and in the Mac app the microphone stayed dead after it was cancelled.
 */
function askSure(text, yes = "OK") {
  return new Promise((resolve) => {
    const dlg = $("sureDlg");
    $("sureText").textContent = text;
    $("sureYes").textContent = yes;
    dlg.onclose = () => resolve(dlg.returnValue === "yes");
    dlg.returnValue = "";
    dlg.showModal();
  });
}

// Keeping the microphone alive through anything that pauses the page's audio: a system alert, the
// laptop sleeping, another app taking the mic, a headset unplugged. Whatever stopped it, it is
// started again, and a microphone that has gone dead is opened afresh.
async function keepHearing() {
  if (!onCall || muted || !listener) return;
  if (audioCtx && audioCtx.state !== "running" && audioCtx.state !== "closed") {
    try { await audioCtx.resume(); } catch {}
  }
  if (listener.live && !listener.live()) {
    feedNote("The microphone stopped; opening it again.");
    try { listener.destroy(); } catch {}
    listener = null;
    await openListener();
    if (listener && !muted) startListening();
  }
}
setInterval(keepHearing, 4000);
window.addEventListener("focus", keepHearing);
document.addEventListener("visibilitychange", () => { if (!document.hidden) keepHearing(); });
navigator.mediaDevices?.addEventListener?.("devicechange", () => setTimeout(keepHearing, 500));

async function startListening() {
  try {
    await listener?.start();
  } catch (err) {
    feedError(focusedId, 0, `ClaudeCall cannot open the microphone: ${err.message || err}`);
  }
}
$("muteBtn").onclick = () => {
  muted = !muted;
  $("muteBtn").classList.toggle("on", muted);
  showIcon($("muteBtn"), muted ? "micOff" : "mic");
  $("muteBtn").title = muted ? "Unmute your mic" : "Mute your mic";
  if (muted) {
    listener?.pause();
    // the mic stops without a word: whatever was being said is dropped, and anything held for it
    // let go, so the call is not left "hearing you" for as long as it stays muted
    hearing = false;
    carry = "";
    if ((ducked || continuing) && !userPaused) voice.resume();
    ducked = continuing = false;
  } else startListening();
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
  if (v.startsWith("/") && runSlash(v)) return;
  if (v) heardText(v, { typed: true });
};
try { $("sensitivity").value = localStorage.getItem("sensitivity") || "normal"; } catch {}
try { $("refineToggle").checked = localStorage.getItem("refine") !== "0"; } catch {}
$("refineToggle").onchange = () => { try { localStorage.setItem("refine", $("refineToggle").checked ? "1" : "0"); } catch {} };
// How the lead speaks, and which recogniser hears them. Kept on the server, beside the roster, so
// every device agrees; the accent also widens which spellings count as sounding like a name.
let accent = "";
const syncRec = segment($("recSeg"), "fast", (v) => send({ type: "hearing", recogniser: v }));
$("accentSel").onchange = () => {
  accent = $("accentSel").value;
  // a strong accent is heard far better by the more accurate recogniser: offer it once
  send({ type: "hearing", accent, ...(accent && accent !== "American English" && accent !== "British English" ? { recogniser: "accurate" } : {}) });
};
function hearingSettings(m) {
  accent = m.accent ?? "";
  $("accentSel").value = accent;
  syncRec(m.recogniser ?? "fast");
}
segment($("sensSeg"), $("sensitivity").value, (v) => { $("sensitivity").value = v; $("sensitivity").dispatchEvent(new Event("change")); });
$("sensitivity").onchange = () => {
  listener?.sensitivity?.($("sensitivity").value);
  try { localStorage.setItem("sensitivity", $("sensitivity").value); } catch {}
};
function applyMode() { document.body.classList.toggle("audio", mode() === "audio"); deck.refresh(); }
$("audioOnly").onchange = applyMode;
try { $("phones").checked = localStorage.getItem("phones") === "1"; } catch {}
$("phones").onchange = () => { try { localStorage.setItem("phones", $("phones").checked ? "1" : "0"); } catch {} };
try { earcons.enabled = localStorage.getItem("earcons") !== "0"; $("earcons").checked = earcons.enabled; } catch { $("earcons").checked = true; }
$("earcons").onchange = () => { earcons.enabled = $("earcons").checked; try { localStorage.setItem("earcons", earcons.enabled ? "1" : "0"); } catch {} };
try { earcons.ringEnabled = localStorage.getItem("ring") !== "0"; $("ringToggle").checked = earcons.ringEnabled; } catch { $("ringToggle").checked = true; }
$("ringToggle").onchange = () => { earcons.ringEnabled = $("ringToggle").checked; try { localStorage.setItem("ring", earcons.ringEnabled ? "1" : "0"); } catch {} };
addEventListener("keydown", (e) => {
  if (["INPUT", "TEXTAREA", "SELECT"].includes(e.target.tagName) || e.target.closest?.("dialog")) return;
  // Space presses a focused button or card, as it should for keyboard users; elsewhere it pauses
  const pressable = e.target.closest?.("button, [role=button], a, summary");
  if (e.code === "Space" && pressable?.getAttribute("role") === "button") { e.preventDefault(); pressable.click(); return; }
  if (e.code === "Space" && onCall && !pressable) { e.preventDefault(); userPaused ? resumeBuddy() : pauseBuddy(); }
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

// installable as an app on phones, tablets and computers; browsers refuse a service worker over a
// certificate they do not trust (the self-signed one on a local network), which is fine: it only
// adds the "can't reach your computer" page
if ("serviceWorker" in navigator && isSecureContext) navigator.serviceWorker.register("/sw.js").catch(() => {});

import { Voice } from "./voice.js";
import { Earcons } from "./earcon.js";
import { Central } from "./central.js";
import { createVadListener, createChromeListener } from "./listen.js";
import { esc, renderMarkdown } from "./markdown.js";
import { route, LOCAL } from "./route.js";

const $ = (id) => document.getElementById(id);
const callEl = $("call"), orb = $("orb"), feed = $("feed");

// ---------- state ----------
let ws = null;
let onCall = false, muted = false;
let listener = null;
let projects = []; // the roster, as the server reports it
let focusedId = null;
let centralIdentity = null;
let currentTurn = 0; // the turn whose output we play
let working = false; // the project on the line is busy on currentTurn
let userPaused = false, pausedAt = 0;
let ducked = false; // voice held because the user started talking
let hearing = false;
let callStart = 0, lastActivity = 0, sleepTimer = null;
let lastSpoke = 0; // when you last actually said something, as opposed to work carrying on
let segSeq = 0;
let audioCtx = null;
// Speculative sending: each utterance goes to Claude the moment it is transcribed. If you keep
// talking within MERGE_MS and Buddy has not said anything yet, that turn is quietly replaced by
// one with your whole sentence, so a mid-sentence pause never cuts you off.
const MERGE_MS = 1500;
// Saying the same thing twice this close together overrides the echo guard.
const INSIST_MS = 12_000;
// An update from a background project waits this long after you stop talking, so it does not
// collide with you carrying on your own thought.
const RELAY_SETTLE_MS = 1200;
// However busy the projects are, a call with nobody talking to it ends after this long.
const MAX_UNATTENDED_MS = 45 * 60_000;
let lastAsk = null; // { text, at }
let spokeThisTurn = false;
let continuing = false;
let carry = ""; // transcript that arrived while you were already talking again; joined to what comes next
const dropped = new Set(); // turns replaced by a merged one; their late output is ignored
const notices = []; // notifications waiting for a gap in the conversation
let relayTimer = null;
const mode = () => ($("audioOnly").checked ? "audio" : "visual");
const project = (id) => projects.find((p) => p.id === id) ?? null;
const focused = () => project(focusedId);
const waitingId = () => projects.find((p) => p.waiting)?.id ?? null;
const identityOf = (id) => project(id)?.identity ?? null;

const earcons = new Earcons(null);
const voice = new Voice({
  earcons,
  onSentence: (text, from, record) => { if (record) { spokeThisTurn = true; showBuddy(text, from, from); } render(); },
  onWord: (text, at, len) => { showBuddy(text, at, at + Math.max(len, 1)); orb.classList.add("beat"); setTimeout(() => orb.classList.remove("beat"), 110); },
  onSpeaker: (speaker) => { $("speaker").textContent = speaker === "buddy" ? "Buddy" : project(speaker)?.name ?? ""; render(); },
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
  $("pauseBtn").title = userPaused ? "Go on" : "Pause Buddy";
  $("feedState").innerHTML = working ? '<span class="spin"></span> working' : "";
  const f = focused();
  callEl.style.setProperty("--hue", String(f?.identity?.hue ?? centralIdentity?.hue ?? 18));
  $("onLine").textContent = f ? f.name : "Buddy";
  renderRoster();
}

function renderRoster() {
  const el = $("roster");
  el.innerHTML = "";
  for (const p of projects) {
    const row = document.createElement("button");
    row.className = "proj";
    row.dataset.state = p.state;
    if (p.id === focusedId) row.classList.add("on");
    row.style.setProperty("--hue", String(p.identity?.hue ?? 0));
    row.title = `${p.dir}${p.branch ? ` · ${p.branch}` : ""} · ${p.permissionMode}`;
    const side = (p.identity?.pan ?? 0) < -0.15 ? "◀" : (p.identity?.pan ?? 0) > 0.15 ? "▶" : "◆";
    row.innerHTML =
      `<span class="dot"></span><span class="pname">${esc(p.name)}</span>` +
      `<span class="pside">${side}</span>` +
      `<span class="pstate">${p.waiting ? "needs you" : p.state === "working" ? "working" : p.state}</span>` +
      (p.branch ? `<span class="pbranch">${esc(p.branch)}</span>` : "");
    row.onclick = () => { send({ type: "focus", project: p.id }); };
    el.appendChild(row);
  }
}

function showBuddy(text, a, b) {
  $("capBuddy").innerHTML = `<span class="done">${esc(text.slice(0, a))}</span><span class="now">${esc(text.slice(a, b))}</span><span class="todo">${esc(text.slice(b))}</span>`;
}
function showYou(text, pending) {
  $("capYou").innerHTML = pending ? `<span class="spin"></span> ${esc(text)}` : esc(text);
}

// ---------- behind-the-scenes feed ----------
const cards = new Map(); // key: `${project}:${turn}`
const cardOrder = []; // insertion order, for pruning the oldest once the feed grows long
const key = (pid, turn) => `${pid}:${turn}`;
// A call left running for hours builds thousands of turn cards with nothing to bound them: the
// feed keeps growing, every scroll check and re-render gets heavier, and eventually the tab's
// main thread cannot keep up with its own DOM — which looks, from outside, like a hung tab that
// will not even close. Finished cards past this count are dropped; the live one is never pruned.
const MAX_FEED_CARDS = 150;
function pruneFeed(exceptKey) {
  while (cardOrder.length > MAX_FEED_CARDS) {
    const oldest = cardOrder[0];
    if (oldest === exceptKey) break; // never drop the turn in progress
    cardOrder.shift();
    cards.get(oldest)?.el.remove();
    cards.delete(oldest);
  }
}
function card(pid, turn) {
  const k = key(pid, turn);
  let c = cards.get(k);
  if (c) return c;
  const p = project(pid);
  const el = document.createElement("div");
  el.className = "turn";
  if (p?.identity) el.style.setProperty("--hue", String(p.identity.hue));
  el.innerHTML = `<div class="q"><span class="who">${esc(p?.name ?? "Buddy")}</span><span class="qt"></span><span class="st"><span class="spin"></span></span></div>`;
  if (!dropped.has(turn)) feed.appendChild(el);
  c = { el, last: null, screen: null, screenMd: "", tools: new Map() };
  cards.set(k, c);
  cardOrder.push(k);
  pruneFeed(k);
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
  // Re-parsing the whole block on every chunk is O(n^2) over a long reply: a few hundred chunks
  // into a long `<screen>` and each one re-renders everything received so far. One render per
  // frame, however fast the chunks arrive, keeps the cost bounded by how much actually changed.
  if (!c.screenPending) {
    c.screenPending = true;
    requestAnimationFrame(() => {
      c.screenPending = false;
      c.screen.innerHTML = renderMarkdown(c.screenMd.replace(/^\n+|\s+$/g, ""));
      scrollFeed();
    });
  }
}
function feedError(pid, turn, text) {
  const c = card(pid, turn);
  if (!turn) c.el.querySelector(".qt").textContent = "Note";
  c.el.appendChild(Object.assign(document.createElement("div"), { className: "err", textContent: text }));
  scrollFeed();
}
function feedNote(text) {
  feed.appendChild(Object.assign(document.createElement("div"), { className: "note", textContent: text }));
  scrollFeed();
}
function feedNotice(n) {
  const el = Object.assign(document.createElement("div"), { className: `notice ${n.kind}` });
  const p = project(n.project);
  if (p?.identity) el.style.setProperty("--hue", String(p.identity.hue));
  el.innerHTML = `<b>${esc(n.name)}</b> ${esc(n.text)}`;
  if (n.kind === "permission") {
    const yes = Object.assign(document.createElement("button"), { className: "allow", textContent: `Allow ${n.name}` });
    yes.onclick = () => send({ type: "grant", project: n.project });
    el.appendChild(yes);
  }
  feed.appendChild(el);
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
 * Hold updates from projects you are not listening to until there is a gap: never while you are
 * talking, never while the project on the line is mid-sentence, and not for a moment after you
 * stop, which is when you are most likely to carry on.
 */
function queueNotice(n) {
  notices.push(n);
  feedNotice(n);
  scheduleDrain();
}
function scheduleDrain() {
  clearTimeout(relayTimer);
  if (!notices.length) return;
  relayTimer = setTimeout(drainNotices, RELAY_SETTLE_MS);
}
function drainNotices() {
  if (!notices.length || !onCall) return;
  if (hearing || userPaused || !voice.idle || Date.now() - lastActivity < RELAY_SETTLE_MS) return scheduleDrain();
  const items = notices.splice(0, notices.length);
  central.relay(items.length === 1 ? `${items[0].text}` : batchLine(items));
  render();
}
function batchLine(items) {
  const rank = { permission: 0, failed: 1, finished: 2 };
  const sorted = [...items].sort((a, b) => rank[a.kind] - rank[b.kind] || a.at - b.at);
  const head = sorted.slice(0, 2).map((n) => n.text.replace(/\.$/, ""));
  const rest = sorted.length - 2;
  return `${sorted.length} updates. ${head.join(". And ")}.${rest > 0 ? ` And ${rest} more on screen.` : ""}`;
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
      central.setIdentity(m.identity);
      break;
    case "roster": {
      const first = !projects.length;
      projects = m.projects;
      const changed = focusedId !== m.focused;
      focusedId = m.focused;
      if (first) warnMissingVoices();
      if (changed && !first && focusedId) central.focused(focused());
      break;
    }
    case "transcript": {
      const done = pendingSegments.get(m.id);
      pendingSegments.delete(m.id);
      done?.(m.text || "");
      break;
    }
    case "turn":
      if (dropped.has(m.turn)) break;
      if (m.project === focusedId) { currentTurn = m.turn; working = true; }
      card(m.project, m.turn).el.querySelector(".qt").textContent = m.text;
      scrollFeed();
      break;
    case "say":
      feedSaid(m.project, m.turn, m.text, m.spoken);
      // only the project on the line has a voice; the rest report through Buddy
      if (m.spoken && mine && m.turn === currentTurn) voice.say(m.text, m.turn, { identity: identityOf(m.project), speaker: m.project });
      break;
    case "narrate":
      if (mine && !userPaused) voice.say(m.text, m.turn, { record: false, identity: identityOf(m.project), speaker: m.project });
      break;
    case "thinking": feedThinking(m.project, m.turn, m.text); break;
    case "aside": feedAside(m.project, m.turn, m.text); break;
    case "tool": feedTool(m.project, m.turn, m.id, m.label, m.detail); break;
    case "tool_result": feedToolResult(m.project, m.turn, m.id, m.ok, m.summary, m.detail); break;
    case "screen": feedScreen(m.project, m.turn, m.text); break;
    case "permission": feedNote(`${project(m.project)?.name ?? m.project}: ${m.text}`); break;
    case "notify": queueNotice(m); break;
    case "done":
      finishCard(m.project, m.turn, m.interrupted);
      if (mine) working = false;
      break;
    case "error":
      feedError(m.project, m.turn ?? 0, m.text);
      if (mine) central.say("Sorry, I hit a problem. The details are on screen.");
      break;
  }
  render();
}

function warnMissingVoices() {
  const missing = voice.missing(projects.map((p) => p.identity));
  if (missing.length) feedNote(`${missing.length} of ${projects.length} projects have no matching voice in this browser and will share a fallback. Chrome and Safari on macOS have the full set.`);
}

// ---------- what you said ----------
const norm = (t) => t.toLowerCase().replace(/[^\w' ]/g, " ").replace(/\s+/g, " ").trim();
let lastIgnored = null; // { t, at } so saying it again gets through

function heardText(raw, { typed = false } = {}) {
  if (!typed && hearing) { carry = `${carry} ${raw}`.trim(); return; } // you are still talking: wait for the rest
  if (!typed && carry) { raw = `${carry} ${raw}`; carry = ""; }
  const text = raw.trim();
  const t = norm(text);
  // nothing or a breath
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
  lastActivity = lastSpoke = Date.now();
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
    case "grant":
      send({ type: "grant", project: r.project, scope: r.scope });
      central.granted(project(r.project)?.name ?? "It");
      return;
    case "deny":
      central.denied(project(r.project)?.name ?? "It");
      return;
    case "park":
      send({ type: "park", project: r.project });
      central.parked(project(r.project)?.name ?? "It");
      return;
    default: return ask(r.text, text);
  }
}

function local(name) {
  switch (name) {
    case "pause": return pauseBuddy();
    case "resume": if (userPaused || voice.busy) return resumeBuddy(); return;
    case "stop": return stopFocused();
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
    case "repeat": {
      voice.clear();
      userPaused = false;
      const lines = voice.heard.length ? voice.heard : voice.lastTurnSpoken;
      for (const s of lines.slice()) voice.say(s, currentTurn, { record: false, identity: identityOf(focusedId) ?? centralIdentity, speaker: focusedId ?? "buddy" });
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
  if (merge && currentTurn > 0) {
    // replace the turn we just sent rather than cutting in on it
    dropped.add(currentTurn);
    cards.get(key(focusedId, currentTurn))?.el.remove();
    cards.delete(key(focusedId, currentTurn));
  } else if (voice.busy || working || userPaused) {
    voice.hold();
    const snap = voice.snapshot();
    context = {
      kind: userPaused ? "paused" : "interrupted",
      heard: snap.heard,
      unheard: snap.unheard,
      pausedMs: userPaused ? Date.now() - pausedAt : undefined,
      working,
    };
  }
  voice.clear();
  voice.newTurn();
  userPaused = false;
  if (currentTurn > 0 && !merge) finishCard(focusedId, currentTurn, working);
  lastAsk = { text: prompt, at: Date.now() };
  spokeThisTurn = false;
  currentTurn = -1; // ignore the old turn's tail until the server names the new one
  send({ type: "utterance", project: pid ?? focusedId, text: prompt, context, mode: mode() });
  showYou(shown);
  render();
}

// Cuts the project on the line off right now: the running turn is interrupted on the server,
// not just the voice silenced. "stop" by voice and the stop button both land here, so a button
// press behaves identically to saying it and needs no microphone or echo guard to work.
function stopFocused() {
  voice.clear();
  userPaused = false;
  send({ type: "interrupt", project: focusedId });
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
  callStart = lastActivity = lastSpoke = Date.now();
  $("callBtn").classList.add("end");
  $("callBtn").textContent = "✆";
  $("callBtn").title = "End call";
  for (const id of ["muteBtn", "pauseBtn", "stopBtn", "typeBox"]) $(id).disabled = false;
  send({ type: "call-start", mode: mode() });
  // Safari only allows audio and speech that start inside the click, so do both before any await
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume?.();
  earcons.ctx = audioCtx;
  central.greet(projects);
  try {
    listener ??= await createVadListener({
      audioContext: audioCtx,
      onSpeechStart,
      onMisfire: () => {
        hearing = false;
        if (carry) { const c = carry; carry = ""; heardText(c); return; }
        if ((ducked || continuing) && !userPaused) voice.resume();
        ducked = continuing = false;
        render();
      },
      onSpeechEnd: (pcm) => { hearing = false; render(); transcribe(pcm); },
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
  notices.length = 0;
  listener?.pause();
  voice.clear();
  userPaused = false;
  hearing = false;
  send({ type: "call-end" });
  working = false;
  $("callBtn").classList.remove("end");
  $("callBtn").textContent = "📞";
  $("callBtn").title = "Start call";
  for (const id of ["muteBtn", "pauseBtn", "stopBtn", "typeBox"]) $(id).disabled = true;
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

function transcribe(pcm) {
  const id = String(++segSeq);
  showYou("…", true);
  pendingSegments.set(id, (text) => heardText(text));
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
  // Work in progress keeps the call awake, but only for so long. A project left waiting on a
  // permission nobody answers would otherwise hold the line open indefinitely, which is how a
  // call ends up still running, with its Claude processes, hours after everyone walked away.
  const spoken = Date.now() - lastSpoke;
  const busy = voice.busy || working || notices.length || projects.some((p) => p.state === "working");
  if (busy && spoken < MAX_UNATTENDED_MS) {
    lastActivity = Math.max(lastActivity, Date.now() - sleepMs() + 30_000);
    return;
  }
  if (Date.now() - lastActivity > sleepMs() || spoken > MAX_UNATTENDED_MS) {
    endCall(spoken > MAX_UNATTENDED_MS ? "Nobody has said anything for a while, so I am hanging up." : "Going to sleep. Press call to wake me.");
  }
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
$("stopBtn").onclick = () => stopFocused();
$("statusBtn").onclick = () => local("status");
$("typeForm").onsubmit = (e) => {
  e.preventDefault();
  const v = $("typeBox").value.trim();
  $("typeBox").value = "";
  if (v) heardText(v, { typed: true });
};
function applyMode() { document.body.classList.toggle("audio", mode() === "audio"); }
$("audioOnly").onchange = applyMode;
try { $("phones").checked = localStorage.getItem("phones") === "1"; } catch {}
$("phones").onchange = () => { try { localStorage.setItem("phones", $("phones").checked ? "1" : "0"); } catch {} };
try { earcons.enabled = localStorage.getItem("earcons") !== "0"; $("earcons").checked = earcons.enabled; } catch { $("earcons").checked = true; }
$("earcons").onchange = () => { earcons.enabled = $("earcons").checked; try { localStorage.setItem("earcons", earcons.enabled ? "1" : "0"); } catch {} };
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space" && onCall) { e.preventDefault(); userPaused ? resumeBuddy() : pauseBuddy(); }
  // number keys put a project on the line
  const n = Number(e.key);
  if (onCall && n >= 1 && n <= projects.length) send({ type: "focus", project: projects[n - 1].id });
});

connect();
render();

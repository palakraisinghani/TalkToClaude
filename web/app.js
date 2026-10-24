import { Voice } from "./voice.js";
import { createVadListener, createChromeListener } from "./listen.js";
import { esc, renderMarkdown } from "./markdown.js";

const $ = (id) => document.getElementById(id);
const callEl = $("call"), orb = $("orb"), feed = $("feed");

// ---------- state ----------
let ws = null;
let onCall = false, muted = false;
let listener = null;
let currentTurn = 0; // the turn whose output we play
let working = false; // Claude is busy on currentTurn
let userPaused = false, pausedAt = 0;
let ducked = false; // voice held because the user started talking
let hearing = false;
let callStart = 0, lastActivity = 0, sleepTimer = null;
let segSeq = 0;
let voiceIdleAt = 0;
let audioCtx = null;
// Speculative sending: each utterance goes to Claude the moment it is transcribed. If you keep
// talking within MERGE_MS and Buddy has not said anything yet, that turn is quietly replaced by
// one with your whole sentence, so a mid-sentence pause never cuts you off.
const MERGE_MS = 1500;
let lastAsk = null; // { text, at }
let spokeThisTurn = false;
let continuing = false;
let carry = ""; // transcript that arrived while you were already talking again; joined to what comes next
const dropped = new Set(); // turns replaced by a merged one; their late output is ignored
const mode = () => ($("audioOnly").checked ? "audio" : "visual");

const voice = new Voice({
  onSentence: (text, from, record) => { if (record) { spokeThisTurn = true; showBuddy(text, from, from); } render(); },
  onWord: (text, at, len) => { showBuddy(text, at, at + Math.max(len, 1)); orb.classList.add("beat"); setTimeout(() => orb.classList.remove("beat"), 110); },
  onIdle: () => { voiceIdleAt = Date.now(); render(); },
});

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
}
function showBuddy(text, a, b) {
  $("capBuddy").innerHTML = `<span class="done">${esc(text.slice(0, a))}</span><span class="now">${esc(text.slice(a, b))}</span><span class="todo">${esc(text.slice(b))}</span>`;
}
function showYou(text, pending) {
  $("capYou").innerHTML = pending ? `<span class="spin"></span> ${esc(text)}` : esc(text);
}

// ---------- behind-the-scenes feed ----------
const cards = new Map();
function card(turn) {
  let c = cards.get(turn);
  if (c) return c;
  const el = document.createElement("div");
  el.className = "turn";
  el.innerHTML = `<div class="q"><span class="qt"></span><span class="st"><span class="spin"></span></span></div>`;
  if (!dropped.has(turn)) feed.appendChild(el);
  c = { el, think: null, aside: null, said: null, screen: null, screenMd: "", tools: new Map(), last: null };
  cards.set(turn, c);
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
function feedThinking(turn, text) {
  const c = card(turn);
  const d = block(c, "think", () => { const d = document.createElement("details"); d.className = "think"; d.open = true; d.innerHTML = "<summary>thinking</summary><div></div>"; return d; });
  d.lastChild.textContent += text;
  d.lastChild.scrollTop = d.lastChild.scrollHeight;
  scrollFeed();
}
function feedAside(turn, text) {
  if (!text.trim() && cards.get(turn)?.last?.kind !== "aside") return;
  const c = card(turn);
  const n = block(c, "aside", () => Object.assign(document.createElement("div"), { className: "aside" }));
  n.textContent = (n.textContent + text).replace(/^\n+/, "");
  scrollFeed();
}
function feedTool(turn, id, label, detail) {
  const c = card(turn);
  const n = document.createElement("details");
  n.className = "tool";
  n.innerHTML = `<summary><span class="mark"><span class="spin"></span></span><span class="lbl">${esc(label)}</span><span class="res"></span></summary>`;
  if (detail) n.appendChild(Object.assign(document.createElement("pre"), { className: "io in", textContent: detail }));
  c.el.appendChild(n);
  c.last = { kind: "tool", node: n };
  c.tools.set(id, n);
  scrollFeed();
}
function feedToolResult(turn, id, ok, summary, detail) {
  const n = card(turn).tools.get(id);
  if (!n) return;
  n.classList.add(ok ? "ok" : "bad");
  n.querySelector(".mark").textContent = ok ? "✓" : "✕";
  n.querySelector(".res").textContent = summary;
  if (detail) n.appendChild(Object.assign(document.createElement("pre"), { className: "io out", textContent: detail }));
}
function feedSaid(turn, text) {
  const c = card(turn);
  const n = block(c, "said", () => Object.assign(document.createElement("div"), { className: "said" }));
  n.textContent += (n.textContent ? " " : "") + text;
  scrollFeed();
}
function feedScreen(turn, text) {
  const c = card(turn);
  if (!c.screen) { c.screen = Object.assign(document.createElement("div"), { className: "screen" }); c.el.appendChild(c.screen); }
  c.screenMd += text;
  c.screen.innerHTML = renderMarkdown(c.screenMd.replace(/^\n+|\s+$/g, ""));
  scrollFeed();
}
function feedError(turn, text) {
  const c = card(turn > 0 ? turn : 0);
  if (!turn || turn < 0) c.el.querySelector(".qt").textContent = "Note";
  c.el.appendChild(Object.assign(document.createElement("div"), { className: "err", textContent: text }));
}
function finishCard(turn, interrupted) {
  const c = cards.get(turn);
  if (!c) return;
  c.el.querySelector(".st").textContent = interrupted ? "cut in" : "done";
  if (interrupted) c.el.classList.add("stale");
  c.el.querySelectorAll("details.think").forEach((d) => (d.open = false));
}

// ---------- server connection ----------
const pendingSegments = new Map();
function connect() {
  ws = new WebSocket(`${location.protocol === "https:" ? "wss" : "ws"}://${location.host}`);
  ws.binaryType = "arraybuffer";
  ws.onopen = () => { if (onCall) send({ type: "call-start", mode: mode() }); };
  ws.onmessage = (e) => onServer(JSON.parse(e.data));
  ws.onclose = () => { $("ears").textContent = "reconnecting…"; $("ears").className = "pill warn"; setTimeout(connect, 1000); };
}
const send = (m) => ws?.readyState === 1 && ws.send(JSON.stringify(m));

function onServer(m) {
  const mine = m.turn === undefined || m.turn === currentTurn;
  switch (m.type) {
    case "stt":
      $("ears").textContent = { loading: "ears loading…", ready: "ears ready", error: "server ears failed" }[m.state];
      $("ears").className = "pill " + (m.state === "ready" ? "ok" : "warn");
      break;
    case "transcript": {
      const done = pendingSegments.get(m.id);
      pendingSegments.delete(m.id);
      done?.(m.text || "");
      break;
    }
    case "turn":
      if (dropped.has(m.turn)) break;
      currentTurn = m.turn;
      working = true;
      card(m.turn).el.querySelector(".qt").textContent = m.text;
      scrollFeed();
      break;
    case "say":
      if (!mine) return;
      voice.say(m.text, m.turn);
      feedSaid(m.turn, m.text);
      break;
    case "narrate":
      if (mine && !userPaused) voice.say(m.text, m.turn, { record: false });
      break;
    case "thinking": feedThinking(m.turn, m.text); break;
    case "aside": feedAside(m.turn, m.text); break;
    case "tool": feedTool(m.turn, m.id, m.label, m.detail); break;
    case "tool_result": feedToolResult(m.turn, m.id, m.ok, m.summary, m.detail); break;
    case "screen": feedScreen(m.turn, m.text); break;
    case "done":
      finishCard(m.turn, m.interrupted);
      if (mine) working = false;
      break;
    case "error":
      feedError(m.turn, m.text);
      if (mine) voice.say("Sorry, I hit a problem. The details are on screen.", m.turn, { record: false });
      break;
  }
  render();
}

// ---------- what you said ----------
const norm = (t) => t.toLowerCase().replace(/[^\w' ]/g, " ").replace(/\s+/g, " ").trim();
const PAUSE = /^(pause|pause please|please pause|hold on|hold up|wait|wait a (sec|second|moment|minute)|one sec(ond)?|hang on|just a (sec|second|moment))$/;
const RESUME = /^(go on|go ahead|continue|resume|carry on|keep going|okay go on|ok go on|yes go on|please continue|unpause)$/;

function heardText(raw, { typed = false } = {}) {
  if (!typed && hearing) { carry = `${carry} ${raw}`.trim(); return; } // you are still talking: wait for the rest
  if (!typed && carry) { raw = `${carry} ${raw}`; carry = ""; }
  const text = raw.trim();
  const t = norm(text);
  // nothing, a breath, or Buddy hearing itself through the speakers
  const echoWindow = voice.busy || Date.now() - voiceIdleAt < 2500;
  if (!t || t.length < 2 || (echoWindow && voice.isEcho(text))) {
    if ((ducked || continuing) && !userPaused) voice.resume();
    ducked = continuing = false;
    showYou(t ? `(ignored: ${text})` : "—");
    render();
    return;
  }
  lastActivity = Date.now();
  showYou(text);
  ducked = false;

  if (continuing) {
    continuing = false;
    if (!typed && lastAsk && !PAUSE.test(t) && t !== "stop") return ask(`${lastAsk.text} ${text}`, `${lastAsk.text} ${text}`, { merge: true });
    if (!userPaused) voice.resume();
  }
  if (PAUSE.test(t)) return pauseBuddy();
  if (RESUME.test(t) && (userPaused || voice.busy)) return resumeBuddy();
  if (t === "stop" || t === "stop it" || t === "stop talking") { voice.clear(); userPaused = false; send({ type: "interrupt" }); render(); return; }
  if (/^go to sleep$/.test(t)) return endCall("Going to sleep. Press call to wake me.");
  if (/^(repeat|repeat that|say that again)$/.test(t)) { voice.clear(); userPaused = false; (voice.heard.length ? voice.heard : voice.lastTurnSpoken).slice().forEach((s) => voice.say(s, currentTurn, { record: false })); return; }
  if (/^switch to audio( only)?( mode)?$/.test(t)) { $("audioOnly").checked = true; applyMode(); voice.say("Audio only. I will keep it all spoken.", currentTurn, { record: false }); return; }
  if (/^switch to (visual|video|screen)( mode)?$/.test(t)) { $("audioOnly").checked = false; applyMode(); voice.say("Screen is back.", currentTurn, { record: false }); return; }
  if (t === "shorter") return ask("Give me the shorter version of your last answer.", text);
  ask(text, text);
}

function ask(prompt, shown, { merge = false } = {}) {
  let context = null;
  if (merge && currentTurn > 0) {
    // replace the turn we just sent rather than cutting in on it
    dropped.add(currentTurn);
    cards.get(currentTurn)?.el.remove();
    cards.delete(currentTurn);
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
  if (currentTurn > 0 && !merge) finishCard(currentTurn, working);
  lastAsk = { text: prompt, at: Date.now() };
  spokeThisTurn = false;
  currentTurn = -1; // ignore the old turn's tail until the server names the new one
  send({ type: "utterance", text: prompt, context, mode: mode() });
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
  send({ type: "call-start", mode: mode() });
  // Safari only allows audio and speech that start inside the click, so do both before any await
  audioCtx ??= new (window.AudioContext || window.webkitAudioContext)();
  audioCtx.resume?.();
  voice.say("Hey, I'm here. What are we working on?", 0, { record: false });
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
    feedError(0, `Using the browser's speech recognition instead (${err.message}).`);
    try {
      listener ??= createChromeListener({ onSpeechStart, onText: (t) => { hearing = false; heardText(t); } });
    } catch (e2) {
      feedError(0, `Buddy cannot hear on this browser: ${e2.message}. You can still type.`);
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
  listener?.pause();
  voice.clear();
  userPaused = false;
  hearing = false;
  send({ type: "call-end" });
  working = false;
  $("callBtn").classList.remove("end");
  $("callBtn").textContent = "📞";
  $("callBtn").title = "Start call";
  for (const id of ["muteBtn", "pauseBtn", "typeBox"]) $(id).disabled = true;
  $("timer").textContent = "call ended";
  if (message) voice.say(message, 0, { record: false });
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
  if (voice.busy || working) { lastActivity = Math.max(lastActivity, Date.now() - sleepMs() + 30_000); return; }
  if (Date.now() - lastActivity > sleepMs()) endCall("Going to sleep. Press call to wake me.");
}

// ---------- controls ----------
$("callBtn").onclick = () => (onCall ? endCall() : startCall());
async function startListening() {
  try {
    await listener?.start();
  } catch (err) {
    feedError(0, `Buddy cannot open the microphone: ${err.message || err}`);
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
addEventListener("keydown", (e) => {
  if (e.target.tagName === "INPUT") return;
  if (e.code === "Space" && onCall) { e.preventDefault(); userPaused ? resumeBuddy() : pauseBuddy(); }
});

connect();
render();

// The assistant's sense of when to speak up.
//
// The lead talks to one agent at a time. Everything the rest of the team needs from them —
// permission for something risky, an answer to a question, news that work is done — waits in a
// queue. Nothing from that queue is ever read out uninvited. In a quiet moment the assistant
// says only *that* someone is waiting, and asks whether the lead wants to hear it; the details
// come when the lead says yes, or asks ("what's waiting", "next"). A request from the agent the
// lead is actually talking to is the exception: that conversation is already happening, so it is
// asked at once.
//
// A bare "yes" or "no" is only ever taken as an answer straight after the assistant has asked
// something, inside a short window. Outside that window the same word goes to whoever has the
// floor, like anything else the lead says.
//
// Pure: no DOM, no timers, no sockets. The page feeds it what happened and carries out what it
// returns, which is what lets every rule here be tested.

/** How long after a question the lead's yes or no is taken as the answer to it. */
export const WINDOW_MS = 8000;
/** How long the lead has to have been quiet before a heads-up. */
export const QUIET_MS = 4000;
/** A heads-up about the same items is repeated no more often than this. */
export const REPEAT_MS = 5 * 60_000;

const BLOCKING = new Set(["permission", "question"]);
const RANK = { permission: 0, question: 1, blocked: 2, failed: 3, finished: 4 };

const norm = (t) => (t ?? "").toLowerCase().replace(/[^\w' ]/g, " ").replace(/\s+/g, " ").trim();

const YES = /^(yes|yeah|yep|yup|sure|ok|okay|go ahead|do it|allow|allow it|approve|approved|fine|please|please do|yes please|sounds good|go for it|what is it|what's up|tell me|go on|read it|read them|let's hear it|let me hear it|go|yes go ahead|okay go ahead)$/;
const NO = /^(no|nope|nah|deny|deny it|don't|do not|refuse|no thanks|not that|no don't|don't do it|no way)$/;
const ALWAYS = /^(always|always allow|allow always|yes always|always yes|from now on|every time)$/;
const SKIP = /^(skip|skip it|skip that|pass|next one|move on|never mind|nevermind)$/;
const LATER = /^(later|not now|leave it|after|in a bit|hold that|save it|no not now|not yet|maybe later)$/;
const TAKE = /^(take me (there|to (him|her|them|it))|put me through|go there|let me talk to (him|her|them|it)|talk to (him|her|them|it))$/;

/** What a short reply means, if it is one of the words the assistant listens for. */
export function classify(text) {
  const t = norm(text).replace(/^(um|uh|hmm|so|well|oh) /, "");
  if (ALWAYS.test(t)) return "always";
  if (YES.test(t)) return "yes";
  if (NO.test(t)) return "no";
  if (SKIP.test(t)) return "skip";
  if (LATER.test(t)) return "later";
  if (TAKE.test(t)) return "take";
  return null;
}

/** The queue in the order it is gone through: what blocks someone first, then the oldest. */
export function order(items) {
  return [...items].sort((a, b) => (RANK[a.kind] ?? 9) - (RANK[b.kind] ?? 9) || a.at - b.at);
}

export function createAttention() {
  return { mode: "normal", item: null, until: 0, hold: false, announced: new Set(), lastHeadsUp: 0, skipped: new Set() };
}

const list = (names) => (names.length < 2 ? names.join("") : `${names.slice(0, -1).join(", ")} and ${names[names.length - 1]}`);
const unique = (xs) => [...new Set(xs)];

/** The one line said in a quiet moment: who is waiting, never what about. */
export function headsUpLine(items) {
  if (!items.length) return null;
  const waiting = unique(items.filter((i) => BLOCKING.has(i.kind)).map((i) => i.name));
  const done = unique(items.filter((i) => !BLOCKING.has(i.kind)).map((i) => i.name)).filter((n) => !waiting.includes(n));
  const many = items.length > 1;
  const parts = [];
  if (waiting.length) parts.push(`${list(waiting)} ${waiting.length > 1 ? "are" : "is"} waiting on you`);
  if (done.length) parts.push(`${list(done)} ${done.length > 1 ? "have" : "has"} news`);
  return `${parts.join(", and ")}. Want to hear ${many ? "them" : "it"}?`;
}

/** Is now a good moment for a heads-up? */
export function wantsHeadsUp(state, items, { now, quietMs, voiceIdle, hearing }) {
  if (state.hold || state.mode !== "normal" || !voiceIdle || hearing || quietMs < QUIET_MS || !items.length) return false;
  const fresh = items.some((i) => !state.announced.has(i.uid));
  return fresh || now - state.lastHeadsUp > REPEAT_MS;
}

/** Say the heads-up and wait briefly for a yes. */
export function headsUp(state, items, now) {
  const s = { ...state, mode: "headsUp", item: null, until: now + WINDOW_MS, lastHeadsUp: now, announced: new Set(state.announced) };
  for (const i of items) s.announced.add(i.uid);
  return { state: s, say: [headsUpLine(items)], actions: [] };
}

/** How one item is put to the lead. Permissions and questions wait for an answer; news does not. */
function present(state, item, now) {
  if (item.kind === "permission") {
    return { state: { ...state, mode: "awaiting", item, until: now + WINDOW_MS }, say: [`${item.text.replace(/\.$/, "")}. Allow?`], actions: [] };
  }
  if (item.kind === "question") {
    return { state: { ...state, mode: "awaiting", item, until: now + WINDOW_MS * 2 }, say: [`${item.text.replace(/\s*$/, "")} What should I tell ${item.name}?`], actions: [] };
  }
  return { state: { ...state, mode: "reviewing", item: null }, say: [item.text], actions: [{ type: "dismiss", item }] };
}

/** Go through the queue from wherever it has got to. News is read straight through. */
function proceed(state, items, now, said = [], acts = []) {
  let s = state;
  const say = [...said];
  const actions = [...acts];
  const done = new Set(actions.filter((a) => a.type === "dismiss" || a.type === "grant" || a.type === "deny" || a.type === "tell").map((a) => a.item.uid));
  for (const item of order(items)) {
    if (done.has(item.uid) || s.skipped.has(item.uid)) continue;
    const r = present(s, item, now);
    say.push(...r.say);
    actions.push(...r.actions);
    s = r.state;
    if (s.mode === "awaiting") return { state: s, say, actions };
    done.add(item.uid);
  }
  return { state: { ...s, mode: "normal", item: null, skipped: new Set() }, say: [...say, "That's everything."], actions };
}

/** Start going through the queue, because the lead asked. */
export function review(state, items, now) {
  if (!items.length) return { state: { ...state, mode: "normal", item: null }, say: ["Nobody's waiting on you."], actions: [] };
  return proceed({ ...state, skipped: new Set() }, items, now);
}

/** "Next": go to whoever has waited longest, and bring up what they need. */
export function next(state, items, now) {
  const first = order(items)[0];
  if (!first) return { state: { ...state, mode: "normal", item: null }, say: ["Nobody's waiting on you."], actions: [] };
  const r = present({ ...state, skipped: new Set() }, first, now);
  return { ...r, actions: [{ type: "focus", project: first.project }, ...r.actions] };
}

/** A request from the agent that has the floor: asked straight away. */
export function urgent(state, item, now) {
  if (state.mode === "awaiting") return { state, say: [], actions: [] }; // one question at a time; it is next
  return present(state, item, now);
}

/**
 * Something the lead said. Returns what the assistant does about it, or a passthrough when it is
 * not hers to handle — in which case it goes to whoever has the floor, exactly as said.
 */
export function heard(state, text, items, now) {
  const word = classify(text);
  const live = state.until >= now;

  if (state.mode === "headsUp") {
    if (live && word === "yes") return review({ ...state, mode: "normal" }, items, now);
    if (live && (word === "no" || word === "later")) return { state: { ...state, mode: "normal" }, say: ["Okay."], actions: [] };
    return { state: { ...state, mode: "normal" }, say: [], actions: [{ type: "passthrough" }] };
  }

  if (state.mode === "awaiting" && state.item) {
    const item = state.item;
    const stillThere = items.some((i) => i.uid === item.uid);
    if (!stillThere) return { state: { ...state, mode: "normal", item: null }, say: [], actions: [{ type: "passthrough" }] };
    if (word === "take") return { state: { ...state, mode: "normal", item: null }, say: [], actions: [{ type: "focus", project: item.project }] };
    if (word === "later") return { state: { ...state, mode: "normal", item: null, skipped: new Set() }, say: ["Okay, it'll keep."], actions: [] };
    if (word === "skip") {
      const s = { ...state, skipped: new Set([...state.skipped, item.uid]) };
      return proceed(s, items, now);
    }
    if (item.kind === "permission" && live) {
      if (word === "yes") return proceed(state, items, now, ["Allowed."], [{ type: "grant", item, scope: "once" }]);
      if (word === "always") return proceed(state, items, now, [`Allowed, and ${item.name} won't ask about that again.`], [{ type: "grant", item, scope: "always" }]);
      if (word === "no") return proceed(state, items, now, ["Denied."], [{ type: "deny", item }]);
    }
    if (item.kind === "question" && live && word === null && norm(text).length > 1) {
      return proceed(state, items, now, [`Sent to ${item.name}.`], [{ type: "tell", item, text: text.trim() }]);
    }
    // anything else ends the review; the item stays in the queue, and the words go on as said
    return { state: { ...state, mode: "normal", item: null, skipped: new Set() }, say: [], actions: [{ type: "passthrough" }] };
  }

  return { state, say: [], actions: [{ type: "passthrough" }] };
}

/** Let a window lapse once its time is up. Kept open while the assistant is still talking. */
export function tick(state, now, { speaking }) {
  if (state.mode !== "headsUp" && state.mode !== "awaiting") return state;
  if (speaking) return { ...state, until: Math.max(state.until, now + WINDOW_MS) };
  if (now > state.until) return { ...state, mode: "normal", item: null, skipped: new Set() };
  return state;
}

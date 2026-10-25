import { test } from "node:test";
import assert from "node:assert/strict";
import { classify, confirmFirst, createAttention, headsUp, headsUpLine, heard, next, order, review, tick, urgent, wantsHeadsUp, WINDOW_MS, QUIET_MS } from "./attention.js";

const perm = { uid: 1, project: "juno", name: "Juno", kind: "permission", text: "Juno wants to install dependencies.", at: 10 };
const q = { uid: 2, project: "rex", name: "Rex", kind: "question", text: "Rex asks: Postgres or SQLite?", at: 20 };
const done = { uid: 3, project: "iris", name: "Iris", kind: "finished", text: "Iris has finished. The login page works.", at: 5 };
const T = 1_000_000;
const types = (r) => r.actions.map((a) => a.type);

test("a heads-up says who is waiting, never what about", () => {
  const line = headsUpLine([perm, q, done]);
  assert.equal(line, "Juno and Rex are waiting on you, and Iris has news. Want to hear them?");
  assert.doesNotMatch(line, /dependencies|Postgres/);
  assert.equal(headsUpLine([perm]), "Juno is waiting on you. Want to hear it?");
});

test("a heads-up waits for a quiet moment, and is not repeated for the same items", () => {
  const s = createAttention();
  const ctx = { now: T, quietMs: QUIET_MS, voiceIdle: true, hearing: false };
  assert.equal(wantsHeadsUp(s, [perm], { ...ctx, quietMs: 1000 }), false, "not while the lead is mid-thought");
  assert.equal(wantsHeadsUp(s, [perm], { ...ctx, voiceIdle: false }), false, "not over someone talking");
  assert.equal(wantsHeadsUp({ ...s, hold: true }, [perm], ctx), false, "not while calls are held");
  assert.equal(wantsHeadsUp(s, [perm], ctx), true);
  const after = { ...headsUp(s, [perm], T).state, mode: "normal" };
  assert.equal(wantsHeadsUp(after, [perm], { ...ctx, now: T + 60_000 }), false, "already told");
  assert.equal(wantsHeadsUp(after, [perm, q], { ...ctx, now: T + 60_000 }), true, "something new");
});

test("yes after a heads-up goes through the queue: blocking items first", () => {
  const h = headsUp(createAttention(), [done, perm], T);
  const r = heard(h.state, "yes", [done, perm], T + 1000);
  assert.deepEqual(r.say, ["Juno wants to install dependencies. Allow?"]);
  assert.equal(r.state.mode, "awaiting");
  assert.equal(r.state.item.uid, 1);
});

test("answering a permission in the window grants exactly that request, then carries on", () => {
  const r1 = review(createAttention(), [perm, done], T);
  const r2 = heard(r1.state, "yes", [perm, done], T + 2000);
  assert.deepEqual(r2.actions.map((a) => [a.type, a.item?.uid, a.scope]), [["grant", 1, "once"], ["dismiss", 3, undefined]]);
  assert.deepEqual(r2.say, ["Allowed.", "Iris has finished. The login page works.", "That's everything."]);
  assert.equal(r2.state.mode, "normal");
  assert.deepEqual(r2.actions.map((a) => a.type), ["grant", "dismiss"]);
  assert.equal(heard(r1.state, "always", [perm], T + 2000).actions[0].scope, "always");
  assert.equal(heard(r1.state, "no", [perm], T + 2000).actions[0].type, "deny");
});

test("a bare yes outside any window is not an answer: it goes to whoever has the floor", () => {
  assert.deepEqual(types(heard(createAttention(), "yes", [perm], T)), ["passthrough"]);
  const r1 = review(createAttention(), [perm], T);
  const late = tick(r1.state, T + WINDOW_MS + 1, { speaking: false });
  assert.equal(late.mode, "normal");
  assert.deepEqual(types(heard(late, "yes", [perm], T + WINDOW_MS + 2)), ["passthrough"]);
});

test("the window stays open while the assistant is still talking", () => {
  const r1 = review(createAttention(), [perm], T);
  const s = tick(r1.state, T + WINDOW_MS + 5000, { speaking: true });
  assert.equal(s.mode, "awaiting");
  assert.ok(s.until > T + WINDOW_MS + 5000);
});

test("a question's answer is whatever the lead says next", () => {
  const r1 = review(createAttention(), [q], T);
  assert.deepEqual(r1.say, ["Rex asks: Postgres or SQLite? What should I tell Rex?"]);
  const r2 = heard(r1.state, "SQLite, keep it simple", [q], T + 3000);
  assert.deepEqual(r2.actions.map((a) => [a.type, a.text]), [["tell", "SQLite, keep it simple"]]);
  assert.equal(r2.say[0], "Sent to Rex.");
});

test("skip, later and take-me-there all leave the item in the queue", () => {
  const r1 = review(createAttention(), [perm, q], T);
  const skipped = heard(r1.state, "skip", [perm, q], T + 1000);
  assert.equal(skipped.state.item.uid, 2, "moves on to the next one");
  assert.ok(!skipped.actions.some((a) => a.type === "grant" || a.type === "deny"));
  const later = heard(r1.state, "not now", [perm, q], T + 1000);
  assert.equal(later.state.mode, "normal");
  assert.equal(later.actions.length, 0);
  const take = heard(r1.state, "take me there", [perm, q], T + 1000);
  assert.deepEqual(take.actions, [{ type: "focus", project: "juno" }]);
});

test("anything else said mid-review ends it and goes through unchanged", () => {
  const r1 = review(createAttention(), [perm], T);
  const r2 = heard(r1.state, "run the tests again", [perm], T + 1000);
  assert.deepEqual(types(r2), ["passthrough"]);
  assert.equal(r2.state.mode, "normal");
});

test("next goes to whoever waited longest for something blocking", () => {
  const r = next(createAttention(), [done, q, perm], T);
  assert.deepEqual(r.actions[0], { type: "focus", project: "juno" });
  assert.equal(r.state.item.uid, 1);
  assert.equal(next(createAttention(), [], T).say[0], "Nobody's waiting on you.");
});

test("a request from the agent on the floor is asked at once", () => {
  const r = urgent(createAttention(), { ...perm, onLine: true }, T);
  assert.equal(r.state.mode, "awaiting");
  assert.equal(r.say[0], "Juno wants to install dependencies. Allow?");
});

test("short replies are recognised, longer speech is not mistaken for one", () => {
  assert.equal(classify("Yes."), "yes");
  assert.equal(classify("um, okay"), "yes");
  assert.equal(classify("Always allow"), "always");
  assert.equal(classify("not now"), "later");
  assert.equal(classify("yes and also run the tests"), null);
  assert.deepEqual(order([done, q, perm]).map((i) => i.uid), [1, 2, 3]);
});

test("yes and no, the way people actually say them", () => {
  for (const t of ["Yes.", "Yeah, sure.", "Yes, tell me.", "Sure, go ahead.", "Okay, what is it?", "Alright.", "Mm-hmm.", "Uh huh", "yeah go on", "Okay sounds good"]) assert.equal(classify(t), "yes", t);
  for (const t of ["No.", "Nope.", "No thanks.", "No, don't."]) assert.equal(classify(t), "no", t);
  assert.equal(classify("No, not now."), "later");
  assert.equal(classify("yes always"), "always");
  // a yes that goes on to say something else is not a bare yes
  for (const t of ["Yes, and also run the tests", "okay so what is Rex doing", "sure can you add a README"]) assert.equal(classify(t), null, t);
});

test("after a heads-up, a casual yes reads the news instead of going to whoever has the floor", () => {
  const h = headsUp(createAttention(), [done], T);
  const r = heard(h.state, "Yeah, sure.", [done], T + 1500);
  assert.ok(!r.actions.some((a) => a.type === "passthrough"));
  assert.deepEqual(r.say, ["Iris has finished. The login page works.", "That's everything."]);
});

test("a question's answer can be a plain yes or no", () => {
  const r1 = review(createAttention(), [q], T);
  const r2 = heard(r1.state, "Yes.", [q], T + 2000);
  assert.deepEqual(r2.actions.map((a) => [a.type, a.text]), [["tell", "Yes."]]);
});

test("the window stays open while the lead is still answering", () => {
  const r1 = review(createAttention(), [q], T);
  const s = tick(r1.state, T + 60_000, { speaking: false, hearing: true });
  assert.equal(s.mode, "awaiting");
});

test("a heads-up talked over is offered again later, not lost", () => {
  const h = headsUp(createAttention(), [q], T);
  const over = heard(h.state, "What is the capital of France?", [q], T + 500);
  assert.deepEqual(types(over), ["passthrough"]);
  const ctx = { quietMs: QUIET_MS, voiceIdle: true, hearing: false };
  assert.equal(wantsHeadsUp(over.state, [q], { ...ctx, now: T + 10_000 }), false, "not straight away");
  assert.equal(wantsHeadsUp(over.state, [q], { ...ctx, now: T + 31_000 }), true, "offered again after a gap");
});

test("a late yes still answers the heads-up, unless the agent on the floor has spoken since", () => {
  const h = headsUp(createAttention(), [q], T);
  const over = heard(h.state, "What is the capital of France?", [q], T + 500);
  const late = heard(over.state, "Yeah, sure.", [q], T + 2000);
  assert.equal(late.state.mode, "awaiting", "goes into the review");
  assert.equal(late.state.item.uid, 2);
  const spoke = { ...over.state, floorSpoke: true };
  assert.deepEqual(types(heard(spoke, "Yeah, sure.", [q], T + 2000)), ["passthrough"], "a yes after Milo spoke is Milo's");
  assert.deepEqual(types(heard(over.state, "Yeah, sure.", [q], T + 25_000)), ["passthrough"], "too late");
});

test("'next' on a piece of news reads it and goes back to normal, not stuck mid-review", () => {
  const r = next(createAttention(), [done], T);
  assert.equal(r.state.mode, "normal");
  assert.deepEqual(r.say, [done.text]);
});

test("once the agent on the floor has spoken, a yes is theirs, even inside a heads-up window", () => {
  const h = headsUp(createAttention(), [q], T);
  const r = heard({ ...h.state, floorSpoke: true }, "yes", [q], T + 1000);
  assert.deepEqual(types(r), ["passthrough"]);
});

test("a risky request needs 'confirm': a yes, or a cough heard as one, is asked again", () => {
  const risky = { ...perm, uid: 9, risk: "it deletes files for good", text: "Juno wants to delete the build folder. Careful: it deletes files for good." };
  const r1 = review(createAttention(), [risky], T);
  assert.match(r1.say[0], /Say confirm to allow it/);
  const r2 = heard(r1.state, "yes", [risky], T + 1000);
  assert.equal(r2.actions.length, 0, "not granted on a yes");
  assert.match(r2.say[0], /can't be undone/);
  assert.equal(heard(r1.state, "always", [risky], T + 1000).actions.length, 0, "never 'always' for this");
  const r3 = heard(r2.state, "confirm", [risky], T + 2000);
  assert.deepEqual(r3.actions.map((a) => [a.type, a.scope]), [["grant", "once"]]);
  assert.equal(heard(r1.state, "no", [risky], T + 1000).actions[0].type, "deny");
  const c = confirmFirst(createAttention(), risky, T);
  assert.equal(c.state.mode, "awaiting");
  assert.equal(classify("Confirm."), "confirm");
});

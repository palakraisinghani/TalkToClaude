import { test } from "node:test";
import assert from "node:assert/strict";
import { forAgent, Refiner, tidy } from "./refine.ts";
import type { Agent, AgentEvent } from "./types.ts";

/** A stand-in for the Haiku session: answers each message with `reply(message)` after `delay` ms. */
function stub(reply: (msg: any) => string | null, delay = 5): () => Promise<Agent> {
  return async () => {
    let turns = 0;
    const listeners: ((turn: number, ev: AgentEvent) => void)[] = [];
    return {
      start() {}, interrupt() {}, setPermissionMode() {}, close() {},
      on(l) { listeners.push(l); },
      send(text) {
        const turn = ++turns;
        const out = reply(JSON.parse(text));
        if (out !== null) setTimeout(() => { for (const l of listeners) { l(turn, { kind: "text", text: out }); l(turn, { kind: "done", sessionId: "", interrupted: false }); } }, delay);
        return turn;
      },
    } as Agent;
  };
}
const ctx = { to: "Felix", team: ["Ada", "Felix"], terms: ["auth.py", "pytest"], agentLastSaid: [] };

test("what was misheard is put right, and the agent also sees what was heard", async () => {
  const r = new Refiner({ make: stub((m) => (m.heard.includes("pie test") ? "Felix, run pytest on the auth module." : m.heard)) });
  const out = await r.refine("um felix run pie test on the off module", ctx);
  assert.equal(out.text, "Felix, run pytest on the auth module.");
  assert.equal(out.changed, true);
  assert.equal(forAgent("um felix run pie test on the off module", out), 'Felix, run pytest on the auth module. [speech recognition heard: "um felix run pie test on the off module"]');
});

test("punctuation, capitals and dropped fillers alone do not count as a change", async () => {
  const r = new Refiner({ make: stub(() => "What is Iris doing right now?") });
  const out = await r.refine("um what is iris doing right now", ctx);
  assert.equal(out.changed, false);
  assert.equal(forAgent("um what is iris doing right now", out), "What is Iris doing right now?");
});

test("too slow, unusable, or an answer instead of a fix: the words go through as heard", async () => {
  const slow = new Refiner({ make: stub(() => "fixed text here", 200), timeoutMs: 50 });
  assert.deepEqual(await slow.refine("check the jason config please", ctx).then((x) => [x.text, x.skipped]), ["check the jason config please", "timeout"]);
  const chatty = new Refiner({ make: stub(() => "Sure! I will check the JSON config file for you and report back on the port setting it uses right now.") });
  assert.equal((await chatty.refine("check the jason config", ctx)).skipped, "unusable");
  const silent = new Refiner({ make: stub(() => "") });
  assert.equal((await silent.refine("check the jason config", ctx)).skipped, "unusable");
});

test("a word or two is left alone: names, yeses and commands are the page's", async () => {
  let asked = 0;
  const r = new Refiner({ make: stub((m) => { asked++; return m.heard; }) });
  assert.equal((await r.refine("yes please", ctx)).skipped, "short");
  assert.equal(asked, 0);
});

test("stray quotes, fences and labels are taken off the reply", () => {
  assert.equal(tidy('"Push it to GitHub."'), "Push it to GitHub.");
  assert.equal(tidy("```\nPush it to GitHub.\n```"), "Push it to GitHub.");
  assert.equal(tidy("Corrected: Push it to GitHub."), "Push it to GitHub.");
});

test("the speaker's own spelling is kept when the model only swaps British for American", async () => {
  const r = new Refiner({ make: stub(() => "Please summarize the colors you changed.") });
  const out = await r.refine("please summarise the colours you changed", ctx);
  assert.equal(out.text, "Please summarise the colours you changed.");
  assert.equal(out.changed, false);
});

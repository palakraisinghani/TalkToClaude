import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Call } from "./call.ts";
import { CENTRAL_ID } from "./identity.ts";
import { ReplyParser } from "./parser.ts";

/** A call whose Ada is a stand-in: what she is sent is recorded, and she is "busy" when told. */
function make() {
  const home = mkdtempSync(join(tmpdir(), "cc-act-"));
  const sent: string[] = [];
  const call = new Call({ projects: [], home, systemPrompt: "", centralPrompt: "", callsDir: join(home, "calls"), rewriter: { toSpeech: async (x: string) => x }, send: () => {} });
  const c = call as any;
  const ada = c.projects.get(CENTRAL_ID);
  let turn = 0;
  const fake = { busy: false, isBusy() { return this.busy; }, send(text: string) { sent.push(text); return ++turn; }, setPermissionMode() {}, setModel() {}, close() {}, on() {}, start() {}, mode: "auto" };
  ada.session = fake;
  // projects get a stand-in too, so handing them work starts nothing real
  c.ensure = (id: string) => { const p = c.projects.get(id); p.session ??= { ...fake, busy: false }; return p; };
  return { call, c, ada, fake, sent, names: () => call.roster.filter((p: any) => !p.central).map((p: any) => p.name) };
}
const feed = async (c: any, ada: any, turn: number, text: string) => {
  const parser: ReplyParser = ada.parserFor(turn);
  await c.parsed(ada, turn, parser.feed(text));
  await ada.acting;
};

test("Ada's <new> with a long brief seats the agent the moment it is written", async () => {
  const { c, ada, names } = make();
  await feed(c, ada, 1, `<say>Setting Pip up.</say><new name="Pip" folder="pet">${"Build a roaming desktop cat. ".repeat(60)}</new>`);
  assert.deepEqual(names(), ["Pip"]);
});

test("cutting Ada off tells her, in that same message, what was done and what was not", async () => {
  const { call, c, ada, fake, sent } = make();
  call.ask(CENTRAL_ID, "make two agents");
  const turn = ada.turn;
  fake.busy = true;
  await feed(c, ada, turn, `<new name="Pip" folder="pet">a cat</new><new name="Rex" folder="api">build the`);
  call.ask(CENTRAL_ID, "sorry, go on", { kind: "interrupted", heard: "", unheard: [], working: true });
  const last = sent.at(-1)!;
  assert.match(last, /already carried out: <new name="Pip" folder="pet">/);
  assert.match(last, /still writing <new name="Rex" folder="api">, so it was NOT carried out/);
});

test("a <new> for someone already on the team hands them the brief instead of seating a second one", async () => {
  const { c, ada, names } = make();
  await feed(c, ada, 1, `<new name="Pip" folder="pet">a cat</new>`);
  await feed(c, ada, 2, `<new name="Pip" folder="pet">a cat with a beanbag</new>`);
  await feed(c, ada, 3, `<new name="Pip" folder="elsewhere">and insects</new>`);
  assert.deepEqual(names(), ["Pip"]);
});

test("removing an agent waits for the lead's confirmation, even after Ada's turn ends", async () => {
  const { call, c, ada, names } = make();
  await feed(c, ada, 1, `<new name="Pip" folder="pet">a cat</new>`);
  await feed(c, ada, 2, `<close to="pip"/>`);
  assert.deepEqual(names(), ["Pip"], "removed without confirmation");
  const ask = ada.asks.find((a: any) => a.requestId.startsWith("confirm-"));
  assert.ok(ask, "no confirmation asked");
  await c.handle(ada, 2, { kind: "done", sessionId: "", interrupted: false });
  assert.ok(ada.asks.includes(ask), "the confirmation vanished when her turn ended");
  call.grant(CENTRAL_ID, "once", ask.requestId);
  assert.deepEqual(names(), []);
});

test("cut in on, Ada's floor move is skipped and she is told; her work still happens", async () => {
  const { call, c, ada, fake, sent, names } = make();
  call.ask(CENTRAL_ID, "set up Pip and put me through");
  const turn = ada.turn;
  fake.busy = true;
  await feed(c, ada, turn, `<new name="Pip" folder="pet">a cat</new><switch to="pip"/>`);
  call.ask(CENTRAL_ID, "wait, one more thing", { kind: "interrupted", heard: "", unheard: [], working: true });
  const last = sent.at(-1)!;
  assert.match(last, /already carried out: <new name="Pip"/);
  assert.match(last, /because the lead cut in, <switch to="pip"> did not happen/);
  await c.handle(ada, turn, { kind: "done", sessionId: "", interrupted: true });
  assert.deepEqual(names(), ["Pip"]);
  assert.notEqual(c.focused, "pip", "the floor moved away from the lead who had just cut in");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Call } from "./call.ts";
import { Notebook, teamChanges } from "./notebook.ts";
import { projectFor } from "./projects.ts";
import { CENTRAL_ID } from "./identity.ts";

test("the notebook keeps notes once, forgets on request, and is empty when there is nothing", async () => {
  const file = join(mkdtempSync(join(tmpdir(), "nb-")), "nb.json");
  const nb = new Notebook(file);
  assert.equal(nb.text(), "");
  nb.remember("The lead wants tests first");
  nb.remember("the lead wants tests first");
  nb.remember("Shop uses Postgres");
  assert.deepEqual(nb.snapshot.notes, ["the lead wants tests first", "Shop uses Postgres"]);
  assert.equal(nb.forget("postgres"), 1);
  assert.equal(nb.forget("nothing like it"), 0);
  nb.status("Juno", "The login page is done.");
  nb.log("set up Juno in ~/buddy-home/shop");
  assert.match(nb.text(), /remember: the lead wants tests first.*Juno: "The login page is done."/);
  nb.status("Juno", null);
  assert.doesNotMatch(nb.text(), /login page/);
  // and it is there again after a restart
  await nb.flush();
  assert.deepEqual(JSON.parse(readFileSync(file, "utf8")).notes, ["the lead wants tests first"]);
  assert.deepEqual(new Notebook(file).snapshot.notes, ["the lead wants tests first"]);
});

test("the event log is kept short", () => {
  const nb = new Notebook();
  for (let i = 0; i < 50; i++) nb.log(`event ${i}`);
  assert.equal(nb.snapshot.events.length, 30);
  assert.match(nb.snapshot.events.at(-1)!, /event 49$/);
});

test("team changes name only what is different", () => {
  const a = new Map([["juno", "Juno (id juno) in ~/a: idle"], ["rex", "Rex (id rex) in ~/b: idle"]]);
  assert.equal(teamChanges(a, new Map(a)), "");
  const b = new Map([["juno", "Juno (id juno) in ~/a: working in the background"], ["kai", "Kai (id kai) in ~/c: not started"]]);
  assert.equal(teamChanges(a, b), "[team changes since your last message: Juno (id juno) in ~/a: working in the background; new: Kai (id kai) in ~/c: not started; gone: Rex]");
});

const make = () => {
  const projects = [projectFor("/tmp/a/juno", 0, [], { name: "Juno" })];
  const call = new Call({ projects, home: "/tmp/a", systemPrompt: "", centralPrompt: "", callsDir: "/tmp/a", rewriter: { toSpeech: async (x) => x }, send: () => {}, notebook: new Notebook() });
  const c = call as any;
  const ada = c.projects.get(CENTRAL_ID), juno = c.projects.get("juno");
  // a stand-in for the Claude session: only its identity matters here
  ada.session = {};
  juno.session = {};
  return { c, ada, juno };
};

test("Ada is told the whole team once, then only what changed", () => {
  const { c, ada, juno } = make();
  c.notebook.remember("tests first");
  const first = c.preface(ada, true, false).join(" ");
  assert.match(first, /\[call · /);
  assert.match(first, /from earlier calls — the lead asked you to remember: tests first/);
  assert.match(first, /\[projects: Juno .*: not started\] \[waiting on the lead: nobody/);
  // nothing changed: nothing at all in front of her message
  assert.deepEqual(c.preface(ada, true, false), []);
  juno.state = "working";
  juno.asks = [{ phrase: "install dependencies" }];
  const next = c.preface(ada, true, false).join(" ");
  assert.doesNotMatch(next, /\[projects:|\[call ·|earlier calls/);
  assert.match(next, /team changes since your last message: Juno .*working in the background, paused, waiting for the person to allow: install dependencies; waiting on the lead: Juno/);
});

test("a new session, or a summarised one, is told everything again", () => {
  const { c, ada } = make();
  c.preface(ada, true, false);
  assert.deepEqual(c.preface(ada, true, false), []);
  ada.told = null; // what the "compacted" event does
  assert.match(c.preface(ada, true, false).join(" "), /\[projects:/);
  ada.session = {}; // the session was restarted
  assert.match(c.preface(ada, true, false).join(" "), /\[projects:/);
});

test("a project agent gets the call header only when it changes, and never the team", () => {
  const { c, juno } = make();
  assert.deepEqual(c.preface(juno, false, false), ["[call · visual+audio · you are in the background, your words are not spoken]"]);
  assert.deepEqual(c.preface(juno, false, false), []);
  assert.deepEqual(c.preface(juno, true, false), ["[call · visual+audio · you are on the line]"]);
  // replacing a queued message that may have carried the header: sent again
  assert.equal(c.preface(juno, true, true).length, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { route } from "./route.js";

const P = [{ id: "ada", name: "Ada" }, { id: "rex", name: "Rex" }, { id: "juno", name: "Juno" }];

test("a name plus an instruction moves the line and carries the question", () => {
  assert.deepEqual(route("Ada, run the tests", P), { kind: "address", project: "ada", text: "run the tests" });
  assert.deepEqual(route("rex deploy the web app", P), { kind: "address", project: "rex", text: "deploy the web app" });
});

test("a name on its own just moves the line", () => {
  assert.deepEqual(route("Ada", P), { kind: "focus", project: "ada" });
  assert.deepEqual(route("switch to Rex", P), { kind: "focus", project: "rex" });
  assert.deepEqual(route("talk to juno", P), { kind: "focus", project: "juno" });
});

test("a misheard name never redirects an instruction", () => {
  // "adder" is one edit from "ada" but carries a command: it must go to whoever is on the line
  assert.deepEqual(route("adder delete the config", P), { kind: "ask", text: "adder delete the config" });
});

test("a misheard name on its own is forgiven, since nothing is lost", () => {
  assert.deepEqual(route("adda", P), { kind: "focus", project: "ada" });
  assert.deepEqual(route("junos", P), { kind: "focus", project: "juno" });
  assert.deepEqual(route("zebra", P), { kind: "ask", text: "zebra" });
});

test("a loose match is refused when two projects could answer to it", () => {
  const twins = [{ id: "pike", name: "Pike" }, { id: "pine", name: "Pine" }];
  assert.deepEqual(route("pire", twins), { kind: "ask", text: "pire" });
  assert.deepEqual(route("pike", twins), { kind: "focus", project: "pike" });
});

test("permission is granted by name, or to whoever is waiting", () => {
  assert.deepEqual(route("allow Ada", P), { kind: "grant", project: "ada", scope: "once" });
  assert.deepEqual(route("allow it", P, { waiting: "rex" }), { kind: "grant", project: "rex", scope: "once" });
  assert.deepEqual(route("allow Ada always", P), { kind: "grant", project: "ada", scope: "always" });
  // nothing waiting and nobody named: it is just something to say
  assert.equal(route("allow it", P).kind, "ask");
});

test("granting never collides with resuming the voice", () => {
  assert.deepEqual(route("go ahead", P, { waiting: "ada" }), { kind: "local", name: "resume" });
  assert.deepEqual(route("go on", P, { waiting: "ada" }), { kind: "local", name: "resume" });
});

test("denial reaches whoever is waiting", () => {
  assert.deepEqual(route("deny", P, { waiting: "ada" }), { kind: "deny", project: "ada" });
  assert.deepEqual(route("no don't", P, { waiting: "ada" }), { kind: "deny", project: "ada" });
});

test("page commands win over everything", () => {
  for (const [said, name] of [["pause", "pause"], ["stop", "stop"], ["repeat that", "repeat"], ["status", "status"], ["roll call", "status"], ["stop everyone", "stop-all"], ["shorter", "shorter"], ["go to sleep", "sleep"]]) {
    assert.deepEqual(route(said, P), { kind: "local", name }, said);
  }
});

test("parking takes a name, and bare pause stays a page command", () => {
  assert.deepEqual(route("park Rex", P), { kind: "park", project: "rex" });
  assert.deepEqual(route("pause", P), { kind: "local", name: "pause" });
});

test("anything else goes to whoever is on the line", () => {
  assert.deepEqual(route("why is login failing", P), { kind: "ask", text: "why is login failing" });
});

test("telling a project something does not move the line", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "rex", name: "Rex" }];
  assert.deepEqual(route("tell Rex to use SQLite", Q), { kind: "tell", project: "rex", text: "use SQLite" });
  assert.deepEqual(route("answer rex, the second one", Q), { kind: "tell", project: "rex", text: "the second one" });
  assert.deepEqual(route("reply to Rex: yes go ahead", Q), { kind: "tell", project: "rex", text: "yes go ahead" });
  // the central agent is talked to, not told
  assert.equal(route("tell Ada hello", Q).kind, "ask");
  // a misheard name carries nothing anywhere else
  assert.equal(route("tell rax to stop", Q).kind, "ask");
});

test("asking for updates is a page command", () => {
  for (const s of ["updates", "any updates", "what did I miss"]) assert.deepEqual(route(s, P), { kind: "local", name: "updates" });
});

test("a stand-up is a page command", () => {
  for (const s of ["stand-up", "standup", "team update", "go round the table"]) assert.deepEqual(route(s, P), { kind: "local", name: "standup" });
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { route, spokenName, soundsLike } from "./route.js";

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

test("moving around the team hands-free", () => {
  assert.deepEqual(route("next", P), { kind: "local", name: "next" });
  assert.deepEqual(route("who's waiting?", P), { kind: "local", name: "updates" });
  assert.deepEqual(route("hold my calls", P), { kind: "local", name: "hold" });
  assert.deepEqual(route("I'm free", P), { kind: "local", name: "unhold" });
  assert.deepEqual(route("back to Ada", P), { kind: "focus", project: "ada" });
  assert.deepEqual(route("put me through to Rex", P), { kind: "focus", project: "rex" });
});

test("bye ends the call from anywhere", () => {
  for (const s of ["Bye.", "goodbye", "bye bye", "okay, bye", "hang up", "end the call"]) assert.deepEqual(route(s, P), { kind: "local", name: "sleep" }, s);
  assert.equal(route("bye the way, run the tests", P).kind, "ask");
});

test("calling someone by name wins over whoever has the line", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "milo", name: "Milo" }, { id: "juno", name: "Juno" }];
  assert.deepEqual(route("Hi Ada, can you take me to Juno?", Q), { kind: "focus", project: "juno" });
  assert.deepEqual(route("hey ada what is milo doing", Q), { kind: "address", project: "ada", text: "what is milo doing" });
  assert.deepEqual(route("Okay Aida, start a new project", Q), { kind: "address", project: "ada", text: "start a new project" });
  assert.deepEqual(route("hey Ada", Q), { kind: "focus", project: "ada" });
  assert.deepEqual(route("can you take me to Juno", Q), { kind: "focus", project: "juno" });
  assert.deepEqual(route("let me talk to milo", Q), { kind: "focus", project: "milo" });
  // no name, nothing redirected
  assert.equal(route("hey can you get me the logs", Q).kind, "ask");
  assert.equal(route("take me to the docs folder", Q).kind, "ask");
});

test("asking for the full version is a page command", () => {
  for (const s of ["tell me more", "Give me the full summary.", "full report", "walk me through it"]) assert.deepEqual(route(s, P), { kind: "local", name: "more" }, s);
});

test("saying you are done hands the floor back to the assistant", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "milo", name: "Milo" }];
  for (const t of ["I'm done", "I am done with Milo", "okay that's all thanks", "that is all", "that'll do"]) {
    assert.deepEqual(route(t, Q), { kind: "local", name: "done" }, t);
  }
  // "done" alone may be an answer to the agent's own question, so it stays with the agent
  assert.equal(route("done", Q).kind, "ask");
});

test("the assistant answers to a misheard name said on its own, and only then", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "milo", name: "Milo" }];
  for (const t of ["Aida", "Ida?", "Etta", "Adah", "hey Ida", "Ada please", "Ada, are you there?", "switch to Aida"]) {
    assert.deepEqual(route(t, Q), { kind: "focus", project: "ada" }, t);
  }
  // a sound-alike never redirects an instruction, and an exact project name still wins
  assert.equal(route("Adder run the tests", Q).kind, "ask");
  assert.equal(route("either way fix it", Q).kind, "ask");
  const R = [...Q, { id: "ida", name: "Ida" }];
  assert.deepEqual(route("Ida", R), { kind: "focus", project: "ida" });
});

test("every agent answers to near-sounding spellings of its name, and to its aliases", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "milo", name: "Milo" }, { id: "rex", name: "Rex" }, { id: "juno", name: "Juno" }];
  for (const [t, id] of [["Mylo", "milo"], ["hey Myla", "milo"], ["switch to Mylo", "milo"], ["Wrecks", "rex"], ["Juneau", "juno"]]) {
    assert.deepEqual(route(t, Q), { kind: "focus", project: id }, t);
  }
  // an alias is a chosen name, so it carries an instruction like the name does
  const A = [{ id: "ada", name: "Ada", central: true, aliases: ["aida"] }, { id: "milo", name: "Milo", aliases: ["mylo"] }];
  assert.deepEqual(route("Aida, what is Milo doing", A), { kind: "address", project: "ada", text: "what is Milo doing" });
  assert.deepEqual(route("Mylo run the tests", A), { kind: "address", project: "milo", text: "run the tests" });
  // a sound-alike does not: it falls through to whoever is on the line
  assert.equal(route("Myla run the tests", A).kind, "ask");
});

test("going back after a detour to the assistant", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "otto", name: "Otto" }];
  for (const t of ["back", "go back", "take me back", "okay go back", "back to him", "back to where I was", "return"]) {
    assert.deepEqual(route(t, Q), { kind: "local", name: "back" }, t);
  }
  assert.deepEqual(route("switch back to Otto", Q), { kind: "focus", project: "otto" });
  assert.deepEqual(route("back to Otto", Q), { kind: "focus", project: "otto" });
});

test("being put through with a note goes as a handoff, carrying the rest of the sentence", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "iris", name: "Iris" }, { id: "juno", name: "Juno" }];
  assert.deepEqual(route("Iris can you connect me to Ada and ask her to switch me to Juno", Q), { kind: "handoff", project: "ada", text: "switch me to juno" });
  assert.deepEqual(route("put me through to Ada and tell her I want everyone's status", Q), { kind: "handoff", project: "ada", text: "i want everyone's status" });
  assert.deepEqual(route("connect me to Ada", Q), { kind: "focus", project: "ada" });
});

test("Ada is reached by the ways the recognizer actually mishears her, even beside a similar name", () => {
  // Otto blurs into Ada; a tie goes to her unless the word plainly is the other name
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "otto", name: "Otto" }, { id: "iris", name: "Iris" }];
  for (const t of ["Other", "Order", "Ada, Ada", "a to please", "add a", "Gator, gator", "switch to radar", "back to waiter", "Switched to Ada", "Okey-ada", "Anna"]) {
    const r = route(t, Q);
    assert.ok((r.kind === "focus" || r.kind === "address") && r.project === "ada", `${t} -> ${JSON.stringify(r)}`);
  }
  for (const t of ["Otto", "otter", "auto"]) assert.deepEqual(route(t, Q), { kind: "focus", project: "otto" }, t);
  // fillers and a deferral are never taken for her name
  for (const t of ["later", "ah", "and"]) assert.notEqual(route(t, Q).project, "ada", t);
});

test("a name said on its own is read back as one spelling, however the recognizer wrote it", () => {
  assert.equal(spokenName("Felix."), "felix");
  assert.equal(spokenName("Felix, Felix."), "felix");
  assert.equal(spokenName("hey Feelix please"), "feelix");
  assert.equal(spokenName("a to"), "ato");
  assert.equal(spokenName("can you run the tests"), "");
});

test("teaching names can be started by voice", () => {
  for (const s of ["learn my voice", "teach names", "let's learn the names", "learn how I say the names"]) assert.deepEqual(route(s, P), { kind: "local", name: "teach" }, s);
});

test("an Indian-English accent setting widens what counts as sounding like a name", () => {
  const indian = { accent: "Indian English" };
  assert.equal(soundsLike("Bada", "Ada"), false);
  assert.equal(soundsLike("Bada", "Ada", indian), true);
  assert.equal(soundsLike("hey Vren", "Wren", indian), true);
  assert.equal(soundsLike("Aada", "Ada", indian), true);
  // still not anything at all
  assert.equal(soundsLike("hello", "Milo", indian), false);
  assert.equal(soundsLike("okay", "Ada", indian), false);
});

test("undoing an agent's last turn, by name or for whoever has the line", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "juno", name: "Juno" }];
  assert.deepEqual(route("undo what Juno just did", Q), { kind: "undo", project: "juno" });
  assert.deepEqual(route("Ada, undo Juno's last change", Q), { kind: "undo", project: "juno" });
  assert.deepEqual(route("undo that", Q), { kind: "undo", project: null });
});

test("stopping one agent by name", () => {
  const Q = [{ id: "ada", name: "Ada", central: true }, { id: "juno", name: "Juno" }];
  assert.deepEqual(route("stop Juno", Q), { kind: "stop-agent", project: "juno" });
  assert.deepEqual(route("stop", Q), { kind: "local", name: "stop" });
});

test("teaching one name by voice", () => {
  for (const s of ["learn how I say Juno", "teach Ada's name", "teach Ada again", "teach Ada"]) assert.deepEqual(route(s, P), { kind: "local", name: "teach" }, s);
  assert.equal(route("learn python", P).kind, "ask");
});

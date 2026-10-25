import { test } from "node:test";
import assert from "node:assert/strict";
import { echoScore, isEchoOf, stripEcho } from "./echo.js";

const SPOKEN = "Found it. The token check never waits for verification. Want me to go on?";

test("a verbatim echo of what was said is caught", () => {
  assert.ok(isEchoOf("the token check never waits for verification", SPOKEN));
});

test("an echo survives a dropped or slurred word", () => {
  assert.ok(isEchoOf("the token check waits for verification", SPOKEN));
  assert.ok(isEchoOf("token check never waits verification", SPOKEN));
});

test("common words Buddy happened to use do not make a reply an echo", () => {
  // every one of these words appears in SPOKEN; none of the pairs do
  assert.ok(!isEchoOf("it never found the check", SPOKEN));
  assert.ok(!isEchoOf("so what do you want to do about the tests", SPOKEN));
});

test("a short reply that reuses the topic still gets through", () => {
  assert.ok(!isEchoOf("yes fix the token check please", SPOKEN));
});

test("one word is never an echo, so single-word commands always pass", () => {
  assert.equal(echoScore("stop", SPOKEN), 0);
  assert.equal(echoScore("pause", SPOKEN), 0);
});

test("nothing spoken means nothing to echo", () => {
  assert.equal(echoScore("the token check never waits", ""), 0);
});

test("a command Buddy just offered does score as an echo, so commands must be matched first", () => {
  // "want me to go on?" makes "go on" a pair Buddy said; app.js dispatches local commands
  // before consulting the guard for exactly this reason.
  assert.ok(isEchoOf("go on", SPOKEN));
});

test("talking over the voice keeps your words and drops its own", () => {
  const said = "The build passed and all thirty tests are green. I also cleaned up the old config file.";
  assert.equal(stripEcho("The build passed and all thirty tests wait stop that", said), "wait stop that");
  assert.equal(stripEcho("the build passed and all thirty tests are green", said), "");
  // a few of its words in a row are not an echo: only longer runs it really said are taken out
  assert.equal(stripEcho("run the old config again", said), "run the old config again");
  assert.equal(stripEcho("Milo hold on, use Postgres", said), "Milo hold on, use Postgres");
});

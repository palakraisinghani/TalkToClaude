import { test } from "node:test";
import assert from "node:assert/strict";
import { echoScore, isEchoOf } from "./echo.js";

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

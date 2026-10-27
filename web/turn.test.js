import { test } from "node:test";
import assert from "node:assert/strict";
import { thoughtWait } from "./turn.js";

test("a finished thought is sent after a beat, an unfinished one waits longer, commands at once", () => {
  const P = [{ id: "ada", name: "Ada", central: true }, { id: "juno", name: "Juno" }];
  assert.equal(thoughtWait("Yes.", P), 0);
  assert.equal(thoughtWait("Pause.", P), 0);
  assert.equal(thoughtWait("Juno", P), 0);
  assert.equal(thoughtWait("Take me to Juno.", P), 0);
  assert.equal(thoughtWait("Ada, start a project for a recipe website.", P), 700);
  assert.equal(thoughtWait("Ada, start a project for a recipe website and", P), 1800);
  assert.equal(thoughtWait("make it work with", P), 1800);
  assert.equal(thoughtWait("So the login page needs, um", P), 1800);
  assert.equal(thoughtWait("Use Postgres.", P, { awaiting: true }), 500);
});

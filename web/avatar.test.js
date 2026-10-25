import { test } from "node:test";
import assert from "node:assert/strict";
import { avatar } from "./avatar.js";

test("an agent's face is the same every time, and the team does not all look alike", () => {
  assert.equal(avatar("Otto", 210), avatar("Otto", 210));
  const faces = new Set(["Otto", "Rex", "Juno", "Milo", "Pip", "Kai", "Nova", "Sage"].map((n) => avatar(n, 100)));
  assert.ok(faces.size >= 6, `only ${faces.size} distinct faces`);
});

test("the assistant wears a headset, and every face has a mouth that can move", () => {
  assert.match(avatar("Ada", 18, { central: true }), /<path d="M13\.5 35 a18\.5/);
  for (const n of ["Ada", "Rex", "Sage"]) assert.match(avatar(n, 0), /class="mouth"/);
});

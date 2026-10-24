import { test } from "node:test";
import assert from "node:assert/strict";
import { isNoise } from "./noise.js";

const commands = (t) => /^(stop|pause|wait|go on)$/.test(t) || t === "rex";

test("stage directions and fillers are noise, however long", () => {
  for (const t of ["[coughs]", "(laughs)", "*sneeze*", "Uh.", "Hmm, hmm.", "", "  "]) assert.equal(isNoise(t, 900), true, t);
});

test("a short burst that came back as a stock phrase is noise", () => {
  assert.equal(isNoise("Thank you.", 200), true);
  assert.equal(isNoise("You", 250), true);
  // the same words, clearly spoken, are taken
  assert.equal(isNoise("Thank you.", 800), false);
});

test("short commands and names always get through", () => {
  for (const t of ["Stop.", "pause", "Rex"]) assert.equal(isNoise(t, 120, commands), false, t);
});

test("real speech is never thrown away", () => {
  assert.equal(isNoise("Run the tests", 300), false);
  assert.equal(isNoise("What is Rex doing?", 900), false);
  assert.equal(isNoise("yes", 420), false);
});

test("almost no voice and a word or two is noise", () => {
  assert.equal(isNoise("Hey", 100), true);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { rateName, syllables } from "./namecheck.js";

test("names that blur under drift are flagged, with the reason", () => {
  const ada = rateName("Ada");
  assert.equal(ada.verdict, "weak");
  assert.match(ada.reasons[0], /vowel and a soft "d"/);
  assert.equal(rateName("Kai").verdict, "weak"); // one open syllable: "hi", "bye"
  assert.equal(rateName("Ava").verdict === "good", false);
});

test("names with strong consonants and clear syllables are easy to call", () => {
  for (const n of ["Atlas", "Jasper", "Felix", "Rocket"]) assert.equal(rateName(n).verdict, "good", n);
});

test("a name that is a command, or sounds like a teammate, is the worst kind", () => {
  assert.equal(rateName("Next").verdict, "weak");
  const r = rateName("Milo", ["Mylo"]);
  assert.match(r.reasons.join(" "), /sounds like Mylo/);
});

test("syllables are counted roughly but well enough", () => {
  assert.deepEqual(["Ada", "Atlas", "Kai", "Priya", "Rex"].map(syllables), [2, 2, 1, 2, 1]);
});

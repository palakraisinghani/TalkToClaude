import { test } from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_MODEL, modelChoices, modelLabel } from "./models.js";

test("models are shown by full name and id, the default with its model in brackets", () => {
  assert.equal(DEFAULT_MODEL, "sonnet");
  assert.equal(modelLabel("opus"), "Opus 5.5 (claude-opus-5-5)");
  // a provider's longer id for the same model is still recognised
  assert.equal(modelLabel("claude-sonnet-5-5@20261001"), "Sonnet 5.5 (claude-sonnet-5-5)");
  const choices = modelChoices();
  assert.deepEqual(choices[0], ["", "Default (Sonnet 5.5)"]);
  assert.ok(choices.some(([v, l]) => v === "haiku" && l === "Haiku 5.5 (claude-haiku-5-5)"));
  // a model set by hand that is not in the list is kept as a choice
  assert.deepEqual(modelChoices("claude-custom-1").at(-1), ["claude-custom-1", "claude-custom-1"]);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { controlOf, slashOf } from "./controls.js";
import { route } from "./route.js";

test("spoken controls are recognised, whole utterances only", () => {
  assert.deepEqual(controlOf("Plan mode."), { what: "mode", value: "plan" });
  assert.deepEqual(controlOf("switch to auto mode"), { what: "mode", value: "auto" });
  assert.deepEqual(controlOf("accept edits"), { what: "mode", value: "acceptEdits" });
  assert.deepEqual(controlOf("ask me first"), { what: "mode", value: "manual" });
  assert.deepEqual(controlOf("exit plan mode"), { what: "mode", value: "auto" });
  assert.deepEqual(controlOf("think harder"), { what: "effort", value: "high" });
  assert.deepEqual(controlOf("think really hard"), { what: "effort", value: "max" });
  assert.deepEqual(controlOf("effort extra high"), { what: "effort", value: "xhigh" });
  assert.deepEqual(controlOf("new conversation"), { what: "clear" });
  assert.deepEqual(controlOf("please compact the conversation"), { what: "compact" });
  // ordinary sentences to an agent stay messages
  assert.equal(controlOf("let's plan mode switching for the app"), null);
  assert.equal(controlOf("think harder about the caching layer"), null);
  assert.equal(controlOf("start over on the login page"), null);
});

test("typed slash commands", () => {
  assert.deepEqual(slashOf("/plan"), { what: "mode", value: "plan" });
  assert.deepEqual(slashOf("/effort high"), { what: "effort", value: "high" });
  assert.deepEqual(slashOf("/clear"), { what: "clear" });
  assert.deepEqual(slashOf("/model Opus"), { action: "model", value: "opus" });
  assert.deepEqual(slashOf("/btw what's left?"), { action: "btw", value: "what's left?" });
  assert.ok(slashOf("/frobnicate").error);
  assert.equal(slashOf("not a command"), null);
});

test("the router sends controls to whoever has the floor, or the agent named", () => {
  const projects = [{ id: "ada", name: "Ada", central: true }, { id: "juno", name: "Juno" }];
  assert.deepEqual(route("plan mode", projects), { kind: "control", what: "mode", value: "plan" });
  const named = route("Juno, think harder", projects);
  assert.equal(named.kind, "address");
  assert.equal(named.project, "juno");
  assert.deepEqual(controlOf(named.text), { what: "effort", value: "high" });
});

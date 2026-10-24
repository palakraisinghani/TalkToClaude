import { test } from "node:test";
import assert from "node:assert/strict";
import { batch, notification, permissionPhrase, summarise } from "./notify.ts";

test("a permission request names the project and says how to grant it", () => {
  const n = notification("permission", "Ada", "ada", { tool: "Write", message: "wants to write /tmp/x" });
  assert.match(n.text, /^Ada needs permission to create a file\. Say allow Ada/);
  assert.equal(n.kind, "permission");
});

test("a finished project reports in its own words", () => {
  const n = notification("finished", "Rex", "rex", { said: ["Working on it.", "All thirty tests pass now. Nothing else to do."] });
  assert.equal(n.text, "Rex is done. All thirty tests pass now.");
});

test("a project that said nothing still reports", () => {
  assert.equal(notification("finished", "Rex", "rex", {}).text, "Rex is done.");
});

test("tools become plain words", () => {
  assert.equal(permissionPhrase("Bash"), "run a command");
  assert.equal(permissionPhrase("Edit"), "change a file");
  assert.equal(permissionPhrase("Glob"), "use Glob");
});

test("a long closing sentence is cut to something sayable", () => {
  assert.ok(summarise(["x".repeat(400) + "."]).length <= 140);
});

test("several updates are batched, blocking ones first", () => {
  const items = [
    notification("finished", "Rex", "rex", { said: ["Done with the tests."] }),
    notification("permission", "Ada", "ada", { tool: "Bash" }),
  ];
  const line = batch(items);
  assert.match(line, /^2 updates\. Ada needs permission to run a command/);
  assert.ok(line.indexOf("Ada") < line.indexOf("Rex"));
});

test("more than two updates are counted, not recited", () => {
  const items = ["A", "B", "C", "D"].map((n) => notification("finished", n, n.toLowerCase(), {}));
  assert.match(batch(items), /^4 updates\..*And 2 more on screen\.$/);
});

test("a single update is said plainly, with no count", () => {
  assert.equal(batch([notification("finished", "Rex", "rex", {})]), "Rex is done.");
});

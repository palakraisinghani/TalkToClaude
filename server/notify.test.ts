import { test } from "node:test";
import assert from "node:assert/strict";
import { batch, describeAction, notification, permissionPhrase, ruleFor, summarise } from "./notify.ts";

test("a permission request names the project and says how to grant it", () => {
  const n = notification("permission", "Ada", "ada", { tool: "Write", message: "wants to write /tmp/x" });
  assert.equal(n.text, "Ada wants to create a file.");
  assert.equal(n.kind, "permission");
});

test("a finished project reports in its own words", () => {
  const n = notification("finished", "Rex", "rex", { said: ["Working on it.", "All thirty tests pass now. Nothing else to do."] });
  assert.equal(n.text, "Rex has finished. All thirty tests pass now.");
});

test("a project that said nothing still reports", () => {
  assert.equal(notification("finished", "Rex", "rex", {}).text, "Rex has finished.");
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
  assert.match(line, /^2 updates\. Ada wants to run a command/);
  assert.ok(line.indexOf("Ada") < line.indexOf("Rex"));
});

test("more than two updates are counted, not recited", () => {
  const items = ["A", "B", "C", "D"].map((n) => notification("finished", n, n.toLowerCase(), {}));
  assert.match(batch(items), /^4 updates\..*And 2 more on screen\.$/);
});

test("a single update is said plainly, with no count", () => {
  assert.equal(batch([notification("finished", "Rex", "rex", {})]), "Rex has finished.");
});

test("a question from the background is read out as a plain fact", () => {
  const n = notification("question", "Rex", "rex", { question: "Postgres or SQLite?" });
  assert.equal(n.text, "Rex asks: Postgres or SQLite?");
  const line = batch([notification("finished", "Juno", "juno", {}), n]);
  assert.ok(line.indexOf("Rex") < line.indexOf("Juno"), "questions block, so they go first");
});

test("a paused action is described in words, with the exact command kept for the screen", () => {
  assert.deepEqual(describeAction("Bash", { command: "npm install", description: "Install dependencies" }), { phrase: "install dependencies", detail: "npm install" });
  assert.equal(describeAction("Bash", { command: "rm -rf build" }).phrase, "run a command");
  assert.equal(describeAction("Write", { file_path: "/a/b/notes.md" }).phrase, "create notes.md");
  assert.equal(describeAction("WebFetch", { url: "https://docs.python.org/3/" }).phrase, "open a page on docs.python.org");
  const n = notification("permission", "Rex", "rex", { phrase: "install dependencies" });
  assert.equal(n.text, "Rex wants to install dependencies.");
});

test("allowing a refused action allows exactly that action", () => {
  assert.equal(ruleFor("Bash", { command: "git push --force origin main" }), "Bash(git push --force origin main)");
  assert.equal(ruleFor("Edit", { file_path: "/a/b.ts" }), "Edit(/a/b.ts)");
  assert.equal(ruleFor("WebFetch", { url: "https://example.com/x" }), "WebFetch(domain:example.com)");
  assert.equal(ruleFor("Bash", {}), null);
  assert.equal(ruleFor("Agent", { prompt: "x" }), null);
});

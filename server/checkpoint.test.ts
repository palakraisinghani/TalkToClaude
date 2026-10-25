import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { changedSince, checkpoint, restore } from "./checkpoint.ts";

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "cc-repo-"));
  const g = (...a: string[]) => execFileSync("git", a, { cwd: dir, env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@t", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@t" } }).toString().trim();
  g("init", "-q");
  writeFileSync(join(dir, "a.txt"), "one\n");
  writeFileSync(join(dir, ".gitignore"), "node_modules\n");
  g("add", "."); g("commit", "-qm", "first");
  return { dir, g };
}

test("undo puts the folder back: edits reverted, new files removed, deletions restored", async () => {
  const { dir, g } = repo();
  writeFileSync(join(dir, "draft.txt"), "uncommitted work of the lead's\n"); // already there before the turn
  const cp = await checkpoint(dir, "turn 1", "juno/1");
  assert.ok(cp);
  // the agent's turn
  writeFileSync(join(dir, "a.txt"), "changed\n");
  writeFileSync(join(dir, "new.txt"), "made by the agent\n");
  writeFileSync(join(dir, "draft.txt"), "overwritten\n");
  mkdirSync(join(dir, "node_modules"), { recursive: true });
  writeFileSync(join(dir, "node_modules", "x.js"), "ignored\n");
  const changes = await changedSince(cp!);
  assert.deepEqual(changes.map((c) => c.file).sort(), ["a.txt", "draft.txt", "new.txt"]);
  await restore(cp!);
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "one\n");
  assert.equal(readFileSync(join(dir, "draft.txt"), "utf8"), "uncommitted work of the lead's\n");
  assert.equal(existsSync(join(dir, "new.txt")), false);
  assert.equal(existsSync(join(dir, "node_modules", "x.js")), true, "ignored files are left alone");
  // the lead's own git state is untouched: nothing staged, same branch, same HEAD
  assert.equal(g("diff", "--cached", "--name-only"), "");
  assert.equal(g("log", "--oneline").split("\n").length, 1);
});

test("only the agent's own folder is covered when it sits inside a bigger repository", async () => {
  const { dir } = repo();
  mkdirSync(join(dir, "app"));
  writeFileSync(join(dir, "app", "main.js"), "v1\n");
  const cp = await checkpoint(join(dir, "app"), "turn", "rex/1");
  writeFileSync(join(dir, "app", "main.js"), "v2\n");
  writeFileSync(join(dir, "a.txt"), "someone else's change\n");
  assert.deepEqual((await changedSince(cp!)).map((c) => c.file), ["app/main.js"]);
  await restore(cp!);
  assert.equal(readFileSync(join(dir, "app", "main.js"), "utf8"), "v1\n");
  assert.equal(readFileSync(join(dir, "a.txt"), "utf8"), "someone else's change\n");
});

test("a folder outside any git repository has no checkpoint", async () => {
  assert.equal(await checkpoint(mkdtempSync(join(tmpdir(), "cc-plain-")), "turn", "x/1"), null);
});

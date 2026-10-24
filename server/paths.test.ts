import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveDir, searchWords, spokenToPath } from "./paths.ts";

test("dictated punctuation is read literally", () => {
  assert.equal(spokenToPath("tilde slash code slash api"), "~/code/api");
  assert.equal(spokenToPath("slash users slash palakr slash my"), "/users/palakr/my");
  assert.equal(spokenToPath("home slash scraper"), "~/scraper");
  assert.equal(spokenToPath("tilde slash code slash my dash app"), "~/code/my-app");
});

test("a typed path is left alone", () => {
  assert.equal(spokenToPath("~/code/api"), "~/code/api");
  assert.equal(spokenToPath("/Users/palakr/my/thing"), "/Users/palakr/my/thing");
});

test("words with the slashes swallowed become separate segments", () => {
  assert.equal(spokenToPath("code api"), "code/api");
});

test("filler words are dropped from a search", () => {
  assert.deepEqual(searchWords("the scraper project"), ["scraper"]);
  assert.deepEqual(searchWords("tilde slash code slash my-app"), ["code", "my", "app"]);
});

async function tree() {
  const root = await mkdtemp(join(tmpdir(), "buddy-tree-"));
  for (const d of ["code/api", "code/web", "work/api", "lonely-scraper", "deep/a/b/widgets"]) {
    await mkdir(join(root, d), { recursive: true });
  }
  return root;
}

test("a folder named out loud is found", async () => {
  const root = await tree();
  process.env.BUDDY_SEARCH_ROOTS = root;
  const r = await resolveDir("lonely scraper", root);
  assert.equal(r.kind, "ok");
  assert.equal(r.dir, join(root, "lonely-scraper"));
});

test("an existing path is taken as given, with no searching", async () => {
  const root = await tree();
  process.env.BUDDY_SEARCH_ROOTS = root;
  const r = await resolveDir(join(root, "code", "web"), root);
  assert.equal(r.kind, "ok");
  assert.equal(r.dir, join(root, "code", "web"));
});

test("two folders of the same name are reported, never guessed at", async () => {
  const root = await tree();
  process.env.BUDDY_SEARCH_ROOTS = root;
  const r = await resolveDir("api", root);
  assert.equal(r.kind, "ambiguous");
  assert.equal(r.options?.length, 2);
});

test("an earlier word decides between namesakes", async () => {
  const root = await tree();
  process.env.BUDDY_SEARCH_ROOTS = root;
  const r = await resolveDir("work api", root);
  assert.equal(r.kind, "ok");
  assert.equal(r.dir, join(root, "work", "api"));
});

test("a folder that is not there is reported as missing, with the path when it was explicit", async () => {
  const root = await tree();
  process.env.BUDDY_SEARCH_ROOTS = root;
  const vague = await resolveDir("something nobody has", root);
  assert.equal(vague.kind, "missing");
  assert.equal(vague.dir, undefined); // nothing to offer to create
  const explicit = await resolveDir(join(root, "brand", "new"), root);
  assert.equal(explicit.kind, "missing");
  assert.equal(explicit.dir, join(root, "brand", "new")); // can be offered for creation
});

test("nothing said is nothing resolved", async () => {
  assert.equal((await resolveDir("   ", ".")).kind, "empty");
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { confusable } from "../web/route.js";
import { CONFIG_FILE, aliasesOf, clearName, modelOf, loadProjects, loadSaved, saveRoster, branchOf, projectFor } from "./projects.ts";
import { identityFor, poolSize, CENTRAL } from "./identity.ts";

const withConfig = async (body: unknown) => {
  const dir = await mkdtemp(join(tmpdir(), "buddy-cfg-"));
  if (body !== undefined) await writeFile(join(dir, CONFIG_FILE), JSON.stringify(body));
  return dir;
};

test("no config at all means no projects: Ada opens them when asked", async () => {
  const root = await withConfig(undefined);
  assert.deepEqual(await loadProjects(root, "/tmp/fallback-work"), []);
});

test("a project made during a call is named after its folder", async () => {
  const a = projectFor("/tmp/code/scraper", 0, []);
  assert.equal(a.name, "Scraper");
  assert.equal(a.id, "scraper");
  assert.equal(a.dir, "/tmp/code/scraper");
  assert.equal(a.backgroundPermissionMode, "auto");
  // a name already in use gets a digit, since names are matched from speech
  assert.equal(projectFor("/tmp/other/scraper", 1, ["scraper"]).name, "Scraper2");
  // and its identity follows its place in the roster
  assert.notEqual(projectFor("/x/one", 0, []).identity.pan, projectFor("/x/two", 1, []).identity.pan);
});

test("projects get names, ids and distinct identities", async () => {
  const root = await withConfig({ projects: [{ name: "Juno", dir: "/tmp/api" }, { name: "Rex", dir: "/tmp/web" }] });
  const ps = await loadProjects(root, "/tmp/x");
  assert.deepEqual(ps.map((p) => p.id), ["juno", "rex"]);
  assert.notEqual(ps[0].identity.voices[0], ps[1].identity.voices[0]);
  assert.notEqual(ps[0].identity.pan, ps[1].identity.pan);
  assert.notEqual(ps[0].identity.hue, ps[1].identity.hue);
  // no project may sound like the central voice
  for (const p of ps) assert.ok(!p.identity.voices.includes(CENTRAL.voices[0]));
});

test("every agent runs in auto mode by default, on the line or not", async () => {
  const root = await withConfig({ projects: [{ name: "Juno", dir: "/tmp/api" }] });
  const [ada] = await loadProjects(root, "/tmp/x");
  assert.equal(ada.permissionMode, "auto");
  assert.equal(ada.backgroundPermissionMode, "auto");
});

test("explicit settings win, and nonsense falls back instead of throwing", async () => {
  const root = await withConfig({ projects: [{ name: "Juno", dir: "/tmp/api", voice: "Fred", pan: 9, permissionMode: "nope", engagement: "delegate" }] });
  const [ada] = await loadProjects(root, "/tmp/x");
  assert.equal(ada.identity.voices[0], "Fred");
  assert.equal(ada.identity.pan, 1); // clamped
  assert.equal(ada.permissionMode, "auto"); // unknown mode ignored
  assert.equal(ada.engagement, "delegate");
});

test("duplicate names are made unique, because names are matched from speech", async () => {
  const root = await withConfig({ projects: [{ name: "Juno", dir: "/a" }, { name: "Juno", dir: "/b" }] });
  const ps = await loadProjects(root, "/tmp/x");
  // not "Juno2": that is hard to say and still sounds like Juno; a clear spare name instead
  assert.equal(ps[0].name, "Juno");
  assert.equal(confusable(ps[1].name, ["Ada", "Juno"]), null);
  assert.equal(new Set(ps.map((p) => p.id)).size, 2);
});

test("a name that sounds like another on the call is swapped for a clear one", async () => {
  // Otto blurs into Ada, Mila into Milo: either would make someone hard to reach by voice
  const root = await withConfig({ projects: [{ name: "Milo", dir: "/a" }, { name: "Otto", dir: "/b" }, { name: "Mila", dir: "/c" }] });
  const names = (await loadProjects(root, "/tmp/x")).map((p) => p.name);
  assert.equal(names[0], "Milo");
  for (const n of names.slice(1)) assert.equal(confusable(n, ["Ada", ...names.filter((x) => x !== n)]), null, n);
  assert.equal(clearName("Felix", ["Ada", "Milo"]), "Felix");
  assert.notEqual(clearName("Ida", ["Ada"]), "Ida");
});

test("a broken config file is reported, not silently ignored", async () => {
  const dir = await mkdtemp(join(tmpdir(), "buddy-cfg-"));
  await writeFile(join(dir, CONFIG_FILE), "{ not json");
  await assert.rejects(() => loadProjects(dir, "/tmp/x"), /could not be read/);
  // an explicitly empty roster is fine; it is a broken file that must be reported
  await writeFile(join(dir, CONFIG_FILE), JSON.stringify({ projects: [] }));
  assert.deepEqual(await loadProjects(dir, "/tmp/x"), []);
});

test("identities stay distinct past the end of the pool", () => {
  const a = identityFor(0);
  const wrapped = identityFor(poolSize);
  assert.equal(a.voices[0], wrapped.voices[0]);
  assert.notEqual(a.pitch, wrapped.pitch); // same voice, shifted so they are still tellable apart
});

test("a directory with no git repository reports no branch", async () => {
  assert.equal(await branchOf(await mkdtemp(join(tmpdir(), "buddy-nogit-"))), "");
});

test("no project can take the central agent's name", async () => {
  const root = await withConfig({ projects: [{ name: "Ada", dir: "/tmp/api" }] });
  const [p] = await loadProjects(root, "/tmp/x");
  assert.notEqual(p.name.toLowerCase(), "ada");
  assert.equal(confusable(p.name, ["Ada"]), null);
  assert.equal(confusable(projectFor("/tmp/code/ada", 0, []).name, ["Ada"]), null);
});

test("projects from earlier calls come back with their conversation, unless already listed", async () => {
  const root = await withConfig({ projects: [{ name: "Rex", dir: "/tmp/web" }] });
  const file = join(root, "roster.json");
  await saveRoster(file, [{ name: "Juno", dir: "/tmp/todo", sessionId: "abc" }, { name: "Rex", dir: "/tmp/web", sessionId: "old" }]);
  const ps = await loadProjects(root, "/tmp/x", await loadSaved(file));
  assert.deepEqual(ps.map((p) => [p.name, p.resume]), [["Rex", undefined], ["Juno", "abc"]]);
  assert.deepEqual(await loadSaved(join(root, "missing.json")), []);
});

test("aliases are kept as lowercase single words, without duplicates or junk", () => {
  assert.deepEqual(aliasesOf(["Mylo", "mylo", "Myla", "two words", "", 5, "x"]), ["mylo", "myla"]);
  assert.equal(aliasesOf("mylo"), undefined);
  assert.equal(aliasesOf([]), undefined);
});

test("model names are kept only in the form the CLI takes them", () => {
  assert.equal(modelOf("sonnet"), "sonnet");
  assert.equal(modelOf("claude-opus-5-5[1m]"), "claude-opus-5-5[1m]");
  for (const bad of ["", "default", "--dangerous", "rm -rf /", 5, null]) assert.equal(modelOf(bad), undefined);
});

test("a voice can be changed the way it is natural to say it", async () => {
  const { voicePatch } = await import("./call.ts");
  const now = { rate: 1, volume: 1, pitch: 1 };
  assert.deepEqual(voicePatch({ name: "Karen", speed: "faster", side: "left" }, now), { voice: "Karen", rate: 1.12, volume: undefined, pitch: undefined, pan: -0.7 });
  assert.equal(voicePatch({ volume: "60%" }, now).volume, 0.6);
  assert.equal(voicePatch({ volume: "quieter" }, now).volume, 0.8);
});

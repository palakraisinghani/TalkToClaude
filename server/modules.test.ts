import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Every module must actually load. `node --check` parses a file but does not instantiate it, so
 * it misses scope errors such as a redeclared binding — which only surface when the server boots.
 */
test("every server and web module loads", async () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const web = join(here, "..", "web");
  const files = [
    ...(await readdir(here)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(here, f)),
    // the page's own modules, apart from the ones that need a browser at import time
    ...(await readdir(web)).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js") && !["app.js", "voice.js", "listen.js", "sw.js"].includes(f)).map((f) => join(web, f)),
  ];
  assert.ok(files.length > 10, "expected to find the modules");
  for (const f of files) {
    // index.ts starts a server and loads a model; loading it here would be a side effect
    if (f.endsWith("index.ts")) continue;
    await assert.doesNotReject(() => import(f), `${f} failed to load`);
  }
});

test("the page's browser-only modules at least parse", async () => {
  // app.js, voice.js and listen.js need a browser to run, but a syntax slip should still fail here,
  // not as a blank page
  const { execFileSync } = await import("node:child_process");
  const web = join(fileURLToPath(new URL(".", import.meta.url)), "..", "web");
  for (const f of ["app.js", "voice.js", "listen.js", "stereo.js", "sw.js"]) {
    assert.doesNotThrow(() => execFileSync(process.execPath, ["--check", join(web, f)], { stdio: "pipe" }), `${f} does not parse`);
  }
});

test("Whisper's inventions are dropped: stock phrases, loops, and too many words for the clip", async () => {
  const { unhallucinate } = await import("./stt.ts");
  assert.equal(unhallucinate("This is the first time I've ever seen a video."), "");
  assert.equal(unhallucinate("I mean, I mean, I mean, I mean, I mean"), "I mean");
  assert.equal(unhallucinate("The second the Kichurda and then some more words here", [], 0.8), "");
  assert.equal(unhallucinate("Ada, run the tests", [], 1.5), "Ada, run the tests");
  assert.equal(unhallucinate("Ada, Juno, Milo", ["Ada", "Juno", "Milo"]), "");
});

test("the installed app's manifest is valid and names files that exist", async () => {
  const { readFile, access } = await import("node:fs/promises");
  const web = join(fileURLToPath(new URL(".", import.meta.url)), "..", "web");
  const m = JSON.parse(await readFile(join(web, "manifest.webmanifest"), "utf8"));
  assert.equal(m.display, "standalone");
  assert.ok(m.icons.some((i: any) => i.sizes === "512x512" && i.purpose === "maskable"));
  for (const i of m.icons) await access(join(web, i.src));
  await access(join(web, "apple-touch-icon.png"));
  await access(join(web, "offline.html"));
});

test("a clip longer than Whisper hears at once is split, between words, into pieces it can hear whole", async () => {
  const { splitLong } = await import("./stt.ts");
  const R = 16000;
  // 70 s of "speech" with a quiet gap at 25 s and at 52 s: the cuts land in the gaps
  const a = new Float32Array(70 * R).map((_, i) => 0.3 * Math.sin(i / 7));
  for (const s of [25, 52]) a.fill(0, s * R, s * R + 0.3 * R);
  const pieces = splitLong(a);
  assert.ok(pieces.every((p) => p.length <= 28 * R), "a piece is longer than 28 s");
  assert.equal(pieces.reduce((n, p) => n + p.length, 0), a.length, "audio lost or doubled at a cut");
  assert.ok(Math.abs(pieces[0].length / R - 25.15) < 0.2, `first cut at ${pieces[0].length / R}s, not in the gap`);
  assert.deepEqual(splitLong(new Float32Array(10 * R)).length, 1);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { dtw, features, Voiceprints } from "./voiceprint.ts";

/** A made-up "word": a tone gliding between frequencies, with a little noise, padded with quiet. */
function word(from: number, to: number, ms: number, seed = 1): Float32Array {
  const n = Math.round((ms / 1000) * 16000), pad = 4000;
  const out = new Float32Array(n + 2 * pad);
  let phase = 0, r = seed;
  for (let i = 0; i < n; i++) {
    const f = from + ((to - from) * i) / n;
    phase += (2 * Math.PI * f) / 16000;
    r = (r * 16807) % 2147483647;
    out[pad + i] = 0.5 * Math.sin(phase) + 0.25 * Math.sin(2.7 * phase) + ((r / 2147483647) - 0.5) * 0.02;
  }
  return out;
}

test("the same sound lines up with itself, and a faster saying of it stays close", () => {
  const a = features(word(300, 900, 600));
  assert.ok(a.length > 40 && a[0].length === 24); // 12 coefficients and how each is changing
  assert.equal(dtw(a, a), 0);
  const faster = features(word(300, 900, 450, 7));
  const other = features(word(900, 300, 600, 3));
  assert.ok(dtw(a, faster) < dtw(a, other) / 2, `${dtw(a, faster)} vs ${dtw(a, other)}`);
});

test("a taught voice names its agent, and leaves other sounds alone", async () => {
  const v = new Voiceprints(await mkdtemp(join(tmpdir(), "cc-voice-")));
  await v.add("felix", [features(word(300, 900, 600, 1)), features(word(300, 900, 520, 2)), features(word(300, 900, 680, 3))]);
  await v.add("iris", [features(word(1200, 500, 500, 4)), features(word(1200, 500, 560, 5))]);
  assert.equal(v.match(features(word(300, 900, 580, 9)))?.id, "felix");
  assert.equal(v.match(features(word(1200, 500, 530, 8)))?.id, "iris");
  assert.equal(v.match(features(word(2000, 2400, 600, 6))), null); // a sound nobody taught
  assert.equal(v.match(features(word(300, 900, 30, 6))), null); // a click is not a name
});

test("templates are kept on disk, reloaded, and cleared on a rename", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-voice-"));
  const v = new Voiceprints(dir);
  await v.add("felix", [features(word(300, 900, 600))]);
  const again = new Voiceprints(dir);
  await again.load();
  assert.equal(again.count("felix"), 1);
  await again.clear("felix");
  const third = new Voiceprints(dir);
  await third.load();
  assert.equal(third.count("felix"), 0);
});

test("teaching: consistent tries become confident, an odd one is dropped, a look-alike is flagged", async () => {
  const v = new Voiceprints(await mkdtemp(join(tmpdir(), "cc-voice-")));
  const felix = (ms: number, seed: number) => features(word(300, 900, ms, seed));
  const session = [felix(600, 1), felix(560, 2)];
  let a = v.assess("felix", session);
  assert.equal(a.confident, false); // two is not enough
  session.push(felix(640, 3));
  a = v.assess("felix", session);
  assert.equal(a.kept, 3);
  assert.equal(a.confident, true);
  // a cough or another word in the middle: not like the others, not kept
  session.push(features(word(2000, 2400, 500, 4)));
  a = v.assess("felix", session);
  assert.equal(a.outlier, true);
  assert.equal(a.kept, 3);
  // once Felix is learned, a name that sounds the same in this voice is flagged, not confident
  await v.add("felix", session.slice(0, 3), true);
  const look = [felix(600, 7), felix(590, 8), felix(610, 9)];
  const b = v.assess("fenix", look);
  assert.equal(b.clash, "felix");
  assert.ok(b.confidence < a.confidence, "a look-alike makes it less sure");
  // but more agreeing takes still get it learned: a clash is reported, never a dead end
  const more = v.assess("fenix", [...look, felix(605, 10), felix(595, 11), felix(615, 12)]);
  assert.equal(more.confident, true);
  assert.deepEqual(v.confident(), ["felix"]);
});

test("a confident name stays confident after a restart", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-voice-"));
  const v = new Voiceprints(dir);
  await v.add("iris", [features(word(1200, 500, 500, 1)), features(word(1200, 500, 540, 2)), features(word(1200, 500, 520, 3))], true);
  const again = new Voiceprints(dir);
  await again.load();
  assert.deepEqual(again.confident(), ["iris"]);
});

test("teaching: a bad first try is dropped once the good ones agree, wherever it came", async () => {
  const v = new Voiceprints(await mkdtemp(join(tmpdir(), "cc-voice-")));
  const felix = (ms: number, seed: number) => features(word(300, 900, ms, seed));
  const session = [features(word(2000, 2400, 500, 4)), felix(600, 1), felix(560, 2), felix(640, 3)];
  const a = v.assess("felix", session);
  assert.deepEqual(a.keep, [1, 2, 3]);
  assert.equal(a.outlier, false, "the newest try was fine");
  assert.equal(a.confident, true);
});

test("a name is found inside a longer phrase, and steady noise is never a name", async () => {
  const v = new Voiceprints(await mkdtemp(join(tmpdir(), "cc-voice-")));
  await v.add("felix", [features(word(300, 900, 600, 1)), features(word(300, 900, 520, 2)), features(word(300, 900, 680, 3))]);
  await v.add("iris", [features(word(1200, 500, 500, 4)), features(word(1200, 500, 560, 5))]);
  // "hey" then the name: another sound first, then Felix
  const hey = word(700, 650, 250, 6), name = word(300, 900, 580, 9);
  const phrase = new Float32Array(hey.length + name.length);
  phrase.set(hey, 0); phrase.set(name, hey.length);
  const m = v.match(features(phrase));
  assert.equal(m?.id, "felix");
  assert.ok((m?.startMs ?? 0) > 200, "found after the first sound");
  const hiss = Float32Array.from({ length: 16000 }, (_, i) => Math.sin(i * 12.9898) * 0.05);
  assert.deepEqual(features(hiss), []);
});

import { test } from "node:test";
import assert from "node:assert/strict";
import { StereoEngine, voicedSpans, wordTimes } from "./stereo.js";

// just enough of Web Audio to play a sentence and watch its volume
function fakeCtx() {
  const gains = [];
  return {
    gains,
    currentTime: 0,
    state: "running",
    destination: {},
    decodeAudioData: async () => ({ duration: 2, sampleRate: 8000, getChannelData: () => new Float32Array(16000).fill(0.2) }),
    createBufferSource: () => ({ connect: (n) => n, start() {}, stop() {}, onended: null }),
    createStereoPanner: () => ({ pan: { value: 0 }, connect: (n) => n }),
    createGain() { const g = { gain: { value: 1, setTargetAtTime(v) { this.value = v; } }, connect: (n) => n }; gains.push(g); return g; },
  };
}

test("talking over a voice turns it down at once, and back up if it was nothing", async () => {
  const ctx = fakeCtx();
  const e = new StereoEngine({ ctx, fetchAudio: async () => new ArrayBuffer(8), waitMs: 1000 });
  e.speak({ text: "Juno is on it now.", identity: { volume: 0.9 }, onWord() {}, onEnd() {} });
  await new Promise((r) => setTimeout(r, 10));
  const g = ctx.gains[0].gain;
  assert.equal(g.value, 0.9);
  e.duck(true);
  assert.ok(g.value < 0.2, `still loud: ${g.value}`);
  e.duck(false);
  assert.equal(g.value, 0.9);
  // a sentence that starts while ducked starts quiet
  e.duck(true);
  e.speak({ text: "And Rex too.", identity: { volume: 1 }, onWord() {}, onEnd() {} });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(ctx.gains[1].gain.value < 0.2);
});

test("the highlight follows the voice: silence and pauses in the audio are where the words are not", () => {
  // 0.3 s of silence, "hello there," for 1 s, a 0.4 s pause, "how are you" for 1 s, then silence
  const rate = 8000, sec = (s) => Math.round(s * rate);
  const d = new Float32Array(sec(3));
  d.fill(0.3, sec(0.3), sec(1.3));
  d.fill(0.3, sec(1.7), sec(2.7));
  const buf = { sampleRate: rate, getChannelData: () => d };
  const spans = voicedSpans(buf);
  assert.equal(spans.length, 2);
  assert.ok(Math.abs(spans[0][0] - 0.3) < 0.02 && Math.abs(spans[1][0] - 1.7) < 0.02);
  const t = wordTimes("Hello there, how are you?", spans);
  assert.ok(Math.abs(t[0].t - 0.3) < 0.02, "the first word waits for the voice to start");
  assert.ok(Math.abs(t[2].t - 1.7) < 0.02, "the word after the comma starts when the voice resumes");
  assert.ok(t[1].t > t[0].t && t[1].t < 1.3);
});

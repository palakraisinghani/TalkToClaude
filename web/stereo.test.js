import { test } from "node:test";
import assert from "node:assert/strict";
import { StereoEngine } from "./stereo.js";

// just enough of Web Audio to play a sentence and watch its volume
function fakeCtx() {
  const gains = [];
  return {
    gains,
    currentTime: 0,
    state: "running",
    destination: {},
    decodeAudioData: async () => ({ duration: 2 }),
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

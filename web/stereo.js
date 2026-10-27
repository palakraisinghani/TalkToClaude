// Voices placed in space.
//
// The browser's speechSynthesis goes straight to the speakers and cannot be panned, so every agent
// would sound as if it stood in the middle of your head. On a Mac the server can make each sentence
// as audio in the same system voice instead; here it is played through Web Audio with the agent at
// its own position, so on headphones you know who is talking before you know what they say.
//
// It plugs into Voice as its engine: speak() starts a sentence and reports words and the end, the
// handle's stop() cuts it off. Word timings are estimated from the length of the audio, since
// recorded speech has no word marks; they drive the captions and the echo guard, which only need to
// be roughly right. While one sentence plays the next ones are made, so there is no gap between them.
//
// Making a sentence takes the Mac a couple of seconds (say starts its speech engine every time), far
// longer than the browser takes to start talking. So a sentence whose audio is not ready within
// `waitMs` is handed back as failed and the browser says it, in the same voice but from the middle:
// a voice slightly out of place is better than a silence after the words are already on screen.

/**
 * Where in a clip the voice is actually speaking: [start, end] in seconds, with gaps shorter than a
 * breath merged. Silence at the start and end is left out, and each longer gap is a pause.
 */
export function voicedSpans(buf, { gapS = 0.14 } = {}) {
  const data = buf.getChannelData(0), rate = buf.sampleRate;
  const F = Math.max(1, Math.round(rate * 0.01)); // 10 ms frames
  const n = Math.floor(data.length / F);
  if (!n) return [];
  const rms = new Float32Array(n);
  let peak = 0;
  for (let f = 0; f < n; f++) {
    let e = 0;
    for (let i = f * F; i < (f + 1) * F; i++) e += data[i] * data[i];
    rms[f] = Math.sqrt(e / F);
    if (rms[f] > peak) peak = rms[f];
  }
  const on = Math.max(0.004, peak * 0.06); // voiced: within ~24 dB of the loudest
  const spans = [];
  let s = -1, lastOn = -1;
  for (let f = 0; f < n; f++) {
    if (rms[f] >= on) {
      if (s < 0) s = f;
      else if ((f - lastOn) * 0.01 > gapS) { spans.push([s * 0.01, (lastOn + 1) * 0.01]); s = f; }
      lastOn = f;
    }
  }
  if (s >= 0) spans.push([s * 0.01, (lastOn + 1) * 0.01]);
  return spans;
}

/**
 * When each word of `text` starts, given where the voice speaks (voicedSpans). A first guess shares
 * the voiced time among the words by length, leaving room for a pause after punctuation. Then each
 * comma or full stop is pinned to the pause the voice really made nearest to where it was guessed:
 * the word after it starts when the voice resumes. Between pinned points the words share the time
 * by length. Returns [{ index, length, t }].
 */
export function wordTimes(text, spans) {
  const words = [...text.matchAll(/\S+/g)].map((m) => ({ index: m.index, length: m[0].length, word: m[0] }));
  if (!words.length) return [];
  if (!spans.length) return words.map((w) => ({ index: w.index, length: w.length, t: 0 }));
  const weight = (w) => w.word.replace(/[^\p{L}\p{N}]/gu, "").length + 1.5;
  const pauseAfter = (w) => (/[.!?…]["')\]]*$/.test(w.word) ? 6 : /[,;:—–]["')\]]*$/.test(w.word) ? 3 : 0);
  const start = spans[0][0], end = spans[spans.length - 1][1];
  // the first guess, over the voiced time as a whole
  const total = words.reduce((n, w) => n + weight(w) + pauseAfter(w), 0);
  const guess = [];
  let acc = 0;
  for (const w of words) { guess.push(start + (acc / total) * (end - start)); acc += weight(w) + pauseAfter(w); }
  // pin each break to the nearest real pause, in order, within reach
  const gaps = spans.slice(0, -1).map((sp, k) => ({ from: sp[1], to: spans[k + 1][0] }));
  const pins = [{ word: 0, t: start }];
  let g = 0;
  for (let i = 0; i + 1 < words.length; i++) {
    if (!pauseAfter(words[i])) continue;
    const want = guess[i + 1];
    let best = -1, dist = 0.8; // seconds
    for (let k = g; k < gaps.length; k++) {
      const d = Math.abs((gaps[k].from + gaps[k].to) / 2 - want);
      if (d < dist) { dist = d; best = k; }
    }
    if (best >= 0) { pins.push({ word: i + 1, t: gaps[best].to, endPrev: gaps[best].from }); g = best + 1; }
  }
  pins.push({ word: words.length, t: end, endPrev: end });
  // between pins, the words share the time by length (pauses the audio did not show still count)
  const out = [];
  for (let p = 0; p + 1 < pins.length; p++) {
    const ws = words.slice(pins[p].word, pins[p + 1].word);
    const from = pins[p].t, to = pins[p + 1].endPrev;
    const tot = ws.reduce((n, w, j) => n + weight(w) + (j < ws.length - 1 ? pauseAfter(w) : 0), 0) || 1;
    let a = 0;
    ws.forEach((w, j) => { out.push({ index: w.index, length: w.length, t: from + (a / tot) * Math.max(0, to - from) }); a += weight(w) + (j < ws.length - 1 ? pauseAfter(w) : 0); });
  }
  return out;
}

/** How loud a voice stays while the lead talks over it. */
const DUCKED = 0.18;

export class StereoEngine {
  /**
   * `fetchAudio(text, identity)` resolves to WAV bytes (an ArrayBuffer) for one sentence.
   * `width` scales how far apart the voices sit: 1 uses each agent's full position.
   */
  constructor({ ctx, fetchAudio, width = 1, waitMs = 350 }) {
    this.ctx = ctx;
    this.waitMs = waitMs;
    this.fetchAudio = fetchAudio;
    this.width = width;
    this.cache = new Map(); // text+voice -> Promise<AudioBuffer>
    this.playing = null; // { out, base }: the sentence now sounding, for duck()
    this.handles = new Set(); // every sentence started and not yet over, for stopAll()
    this.ducked = false;
  }

  /**
   * Turn the voice down at once (the lead started talking over it) or back up. Turned down, not
   * stopped: if it was only noise or its own echo the sentence carries on; if it was the lead, the
   * caller stops it a moment later, once their words are in.
   */
  duck(on) {
    this.ducked = on;
    const p = this.playing;
    if (!p) return;
    p.out.gain.setTargetAtTime(on ? p.base * DUCKED : p.base, this.ctx.currentTime, 0.04);
  }

  #key(text, identity) { return `${identity?.voices?.[0] ?? ""}|${identity?.rate ?? 1}|${text}`; }

  #buffer(text, identity) {
    const k = this.#key(text, identity);
    let p = this.cache.get(k);
    if (!p) {
      p = this.fetchAudio(text, identity).then((bytes) => this.ctx.decodeAudioData(bytes));
      p.catch(() => this.cache.delete(k));
      this.cache.set(k, p);
      // a few sentences ahead is plenty; old ones are let go
      if (this.cache.size > 12) this.cache.delete(this.cache.keys().next().value);
    }
    return p;
  }

  /** Start making a sentence that is coming up, so it is ready when its turn comes. */
  prefetch(text, identity) {
    if (text) this.#buffer(text, identity).catch(() => {});
  }

  /**
   * Say `text` at the identity's position. `onWord(index, length)` as each word is (about) reached,
   * `onEnd(failed)` when it is over; `failed` means the audio could not be had, so the caller can
   * fall back to the browser's own speech.
   */
  speak({ text, identity, onWord, onEnd }) {
    const ctx = this.ctx;
    let stopped = false, src = null;
    const timers = [];
    // not ready in time: the browser says this one (the audio is still made, for a repeat)
    const late = setTimeout(() => { if (!stopped) { stopped = true; onEnd(true); } }, this.waitMs);
    this.#buffer(text, identity).then((buf) => {
      clearTimeout(late);
      if (stopped) return;
      if (ctx.state === "suspended") ctx.resume().catch(() => {});
      src = ctx.createBufferSource();
      src.buffer = buf;
      const out = ctx.createGain();
      const base = identity?.volume ?? 1; // each agent's own loudness
      out.gain.value = this.ducked ? base * DUCKED : base;
      this.playing = { out, base };
      const pan = ctx.createStereoPanner?.();
      if (pan) { pan.pan.value = Math.max(-1, Math.min(1, (identity?.pan ?? 0) * this.width)); src.connect(pan).connect(out); }
      else src.connect(out);
      out.connect(ctx.destination);
      // Each word's moment, read from the audio itself: where the voice starts and stops, and the
      // pauses it makes at commas and full stops. The highlight used to spread the words evenly
      // over the whole clip, so it ran ahead of the voice through the silence at the start and
      // every pause, and only met it again at the end.
      const times = wordTimes(text, voicedSpans(buf));
      // what is played now is heard a little later: the output's own delay, larger on Bluetooth
      const delay = (ctx.outputLatency || 0) + (ctx.baseLatency || 0);
      const startAt = ctx.currentTime + 0.02;
      for (const w of times) {
        const at = (startAt + w.t + delay - ctx.currentTime) * 1000;
        timers.push(setTimeout(() => { if (!stopped) onWord(w.index, w.length); }, Math.max(0, at)));
      }
      src.onended = () => { this.handles.delete(handle); if (this.playing?.out === out) this.playing = null; if (!stopped) { stopped = true; onEnd(false); } };
      src.start(startAt);
    }).catch(() => { clearTimeout(late); if (!stopped) { stopped = true; onEnd(true); } });
    const handle = {
      stop: () => {
        stopped = true;
        this.handles.delete(handle);
        clearTimeout(late);
        timers.forEach(clearTimeout);
        try { src?.stop(); } catch {}
      },
    };
    this.handles.add(handle);
    return handle;
  }

  /** Stop every sentence still sounding or about to: only one voice is ever heard at a time. */
  stopAll() {
    for (const h of [...this.handles]) h.stop();
  }
}

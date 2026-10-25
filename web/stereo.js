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
      out.gain.value = identity?.volume ?? 1; // each agent's own loudness
      const pan = ctx.createStereoPanner?.();
      if (pan) { pan.pan.value = Math.max(-1, Math.min(1, (identity?.pan ?? 0) * this.width)); src.connect(pan).connect(out); }
      else src.connect(out);
      out.connect(ctx.destination);
      // words land roughly in proportion to how far into the text they are
      const span = Math.max(1, text.length);
      for (const m of text.matchAll(/\S+/g)) {
        timers.push(setTimeout(() => { if (!stopped) onWord(m.index, m[0].length); }, (m.index / span) * buf.duration * 1000));
      }
      src.onended = () => { if (!stopped) { stopped = true; onEnd(false); } };
      src.start();
    }).catch(() => { clearTimeout(late); if (!stopped) { stopped = true; onEnd(true); } });
    return {
      stop: () => {
        stopped = true;
        clearTimeout(late);
        timers.forEach(clearTimeout);
        try { src?.stop(); } catch {}
      },
    };
  }
}

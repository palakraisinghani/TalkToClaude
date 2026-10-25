// Variation for one "take" of a word: what a real person, mic and room add each time.
//
// Speed and pitch drift (resampling), a different mic tone, room echo, automatic gain with soft
// clipping, background noise at 12–30 dB, and silence around the word as a voice detector delivers
// it, sometimes with a breath before. Clean synthetic takes say every word identically and make any
// recogniser look perfect; these do not. Used to test names (namecheck.ts) and by
// scripts/eval-names.ts. Seeded, so a test gives the same answer twice.

export function seeded(seed = 12345) {
  let s = seed;
  return () => ((s = (s * 16807) % 2147483647) / 2147483647);
}

export function take(a: Float32Array, rnd: () => number = seeded()): Float32Array {
  const between = (lo: number, hi: number) => lo + rnd() * (hi - lo);
  // speed and pitch drift together, by resampling
  const f = 1 + between(-0.07, 0.07), n = Math.floor(a.length / f);
  let x = Float32Array.from({ length: n }, (_, i) => { const p = i * f, j = Math.floor(p), r = p - j; return (a[j] ?? 0) * (1 - r) + (a[j + 1] ?? 0) * r; });
  // a different mic: tilt the spectrum
  const t = between(-0.6, 0.6); let lp = 0;
  x = x.map((v) => { lp += 0.15 * (v - lp); return v + t * (t > 0 ? v - lp : lp); });
  // a room: a short tail of reflections
  const len = Math.floor(16000 * between(0.15, 0.5)), wet = between(0.1, 0.35), dry = Float32Array.from(x);
  for (let k = 40; k < len; k += 8) { const g = (rnd() * 2 - 1) * Math.exp((-6.9 * k) / len) * wet * 0.15; for (let i = k; i < x.length; i++) x[i] += dry[i - k] * g; }
  // level, then automatic gain with soft clipping
  const gain = between(0.25, 1.4);
  x = x.map((v) => Math.tanh(v * gain * 1.6) / 1.6);
  // silence and noise around it, as a VAD segment has, sometimes with a breath before the word
  const pre = Math.round(16000 * between(0.25, 0.6)), post = Math.round(16000 * between(0.3, 0.95));
  let p = 0; for (const v of x) p += v * v; p /= Math.max(1, x.length);
  const amp = Math.sqrt(p / 10 ** (between(12, 30) / 10)), out = new Float32Array(pre + x.length + post);
  let brown = 0;
  for (let i = 0; i < out.length; i++) { brown = 0.98 * brown + (rnd() - 0.5) * 0.4; out[i] = (i >= pre && i < pre + x.length ? x[i - pre] : 0) + amp * (brown + (rnd() - 0.5)); }
  if (rnd() < 0.3) { const at = Math.max(0, pre - 4000); for (let i = 0; i < 3200; i++) out[at + i] += amp * 3 * (rnd() - 0.5) * Math.sin((Math.PI * i) / 3200); }
  return out;
}

/** The samples of a 16-bit PCM WAV, as -1..1. */
export function wavSamples(b: Buffer): Float32Array {
  for (let o = 12; o < b.length;) {
    const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === "data") return Float32Array.from({ length: size / 2 }, (_, i) => b.readInt16LE(o + 8 + 2 * i) / 32768);
    o += 8 + size + (size % 2);
  }
  return new Float32Array(0);
}

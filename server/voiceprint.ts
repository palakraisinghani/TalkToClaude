import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { hasSpeech, tighten } from "./stt.ts";
export { hasSpeech };

/**
 * Recognising a name from the lead's own voice, not just from the transcript.
 *
 * When the lead teaches the app how they say a name, each try's sound is kept as a short template:
 * its MFCCs, the usual compact description of how speech sounds, frame by frame. Later, anything
 * short they say is compared with every agent's templates by dynamic time warping, which lines up
 * two recordings of the same word said at different speeds. A close enough match names the agent
 * even when the speech recognizer wrote something else for it, or nothing at all.
 *
 * It is speaker-dependent on purpose: it learns this lead's voice and accent, which is exactly
 * where a general recognizer goes wrong. Templates live beside the roster, one file per agent.
 */

const RATE = 16000;
const FRAME = 400; // 25ms
const HOP = 160; // 10ms
const NFFT = 512;
const MELS = 26;
const CEPS = 13;
/** A name taught on its own is short; it is looked for inside anything up to this long. */
export const MAX_NAME_MS = 1800;
/** Utterances up to this long are searched for a taught name: "hey Juno", "Juno, run the tests". */
export const MAX_SEARCH_MS = 6000;
const MAX_TEMPLATES = 8;
/** Frames either side over which each coefficient's mean is taken out (50 frames is half a second). */
const CMN_HALF_WINDOW = 50;
/** Saved templates carry this; ones made with older features cannot be compared and are set aside. */
export const FEATURE_VERSION = 2;

// ---------- features ----------

const hz2mel = (f: number) => 2595 * Math.log10(1 + f / 700);
const mel2hz = (m: number) => 700 * (10 ** (m / 2595) - 1);

const BANK: Float32Array[] = (() => {
  const lo = hz2mel(80), hi = hz2mel(7600);
  const pts = Array.from({ length: MELS + 2 }, (_, i) => mel2hz(lo + ((hi - lo) * i) / (MELS + 1)));
  const bins = pts.map((f) => Math.floor(((NFFT + 1) * f) / RATE));
  return Array.from({ length: MELS }, (_, m) => {
    const w = new Float32Array(NFFT / 2 + 1);
    for (let k = bins[m]; k < bins[m + 1]; k++) w[k] = (k - bins[m]) / Math.max(1, bins[m + 1] - bins[m]);
    for (let k = bins[m + 1]; k < bins[m + 2]; k++) w[k] = (bins[m + 2] - k) / Math.max(1, bins[m + 2] - bins[m + 1]);
    return w;
  });
})();
const HAMMING = Float32Array.from({ length: FRAME }, (_, i) => 0.54 - 0.46 * Math.cos((2 * Math.PI * i) / (FRAME - 1)));
const DCT: Float32Array[] = Array.from({ length: CEPS }, (_, k) => Float32Array.from({ length: MELS }, (_, n) => Math.cos((Math.PI * k * (n + 0.5)) / MELS)));

/** In-place radix-2 FFT. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) { [re[i], re[j]] = [re[j], re[i]]; [im[i], im[j]] = [im[j], im[i]]; }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len;
    for (let i = 0; i < n; i += len) {
      for (let j = 0; j < len / 2; j++) {
        const wr = Math.cos(ang * j), wi = Math.sin(ang * j);
        const ar = re[i + j + len / 2], ai = im[i + j + len / 2];
        const xr = ar * wr - ai * wi, xi = ar * wi + ai * wr;
        re[i + j + len / 2] = re[i + j] - xr; im[i + j + len / 2] = im[i + j] - xi;
        re[i + j] += xr; im[i + j] += xi;
      }
    }
  }
}

/**
 * MFCCs of an utterance, its silence trimmed, with c0 (loudness) dropped and each coefficient's
 * mean taken out, so a quieter or more distant microphone still matches.
 */
export function features(audio: Float32Array): number[][] {
  // a clip with nothing rising clearly above its own background is not speech: a mic blip, a
  // room sound. Templates or matches made from it would match any noise later
  if (!hasSpeech(audio)) return [];
  const a = tighten(audio, 60, 0, 0.07);
  const out: number[][] = [];
  const re = new Float64Array(NFFT), im = new Float64Array(NFFT);
  for (let s = 0; s + FRAME <= a.length; s += HOP) {
    re.fill(0); im.fill(0);
    for (let i = 0; i < FRAME; i++) re[i] = (a[s + i] - 0.97 * (s + i > 0 ? a[s + i - 1] : 0)) * HAMMING[i];
    fft(re, im);
    const power = new Float64Array(NFFT / 2 + 1);
    for (let k = 0; k <= NFFT / 2; k++) power[k] = (re[k] * re[k] + im[k] * im[k]) / NFFT;
    const logmel = BANK.map((w) => { let e = 0; for (let k = 0; k < w.length; k++) e += w[k] * power[k]; return Math.log(e + 1e-10); });
    out.push(DCT.slice(1).map((d) => { let c = 0; for (let n = 0; n < MELS; n++) c += d[n] * logmel[n]; return c; }));
  }
  if (!out.length) return out;
  // Each coefficient is normalised over about a second around each frame — its mean taken out and
  // its spread scaled to one — not over the whole utterance. For a name said alone the two are the same; but in "hey Juno, run the tests"
  // the other words would shift a whole-utterance mean, and "Juno" would no longer sound like the
  // Juno that was taught.
  const dims = out[0].length, W = CMN_HALF_WINDOW;
  const sums = Array.from({ length: dims }, () => new Float64Array(out.length + 1));
  for (let d = 0; d < dims; d++) for (let i = 0; i < out.length; i++) sums[d][i + 1] = sums[d][i] + out[i][d];
  // Scaling the spread as well as the mean is what makes the same word, said on a different day, at
  // a different distance, through a different mic, come out alike: measured on varied takes, the
  // right name ranked closest 90 times in 96 instead of 78.
  const sq = Array.from({ length: dims }, () => new Float64Array(out.length + 1));
  for (let d = 0; d < dims; d++) for (let i = 0; i < out.length; i++) sq[d][i + 1] = sq[d][i] + out[i][d] ** 2;
  const norm = out.map((f, i) => {
    const lo = Math.max(0, i - W), hi = Math.min(out.length, i + W + 1), n = hi - lo;
    return f.map((x, d) => {
      const m = (sums[d][hi] - sums[d][lo]) / n;
      const sd = Math.sqrt(Math.max(1e-6, (sq[d][hi] - sq[d][lo]) / n - m * m));
      return (x - m) / sd;
    });
  });
  // and how each coefficient is changing — the movement of a word, which varies less between
  // takes than its exact sound does
  return norm.map((f, i) => {
    const a = norm[Math.max(0, i - 2)], b = norm[Math.max(0, i - 1)], c = norm[Math.min(norm.length - 1, i + 1)], e = norm[Math.min(norm.length - 1, i + 2)];
    return [...f, ...f.map((_, d) => (c[d] - b[d] + 2 * (e[d] - a[d])) / 10)].map((v) => +v.toFixed(3));
  });
}


/** How unlike two utterances are, after lining them up in time: mean frame distance along the best path. */
export function dtw(a: number[][], b: number[][]): number {
  const n = a.length, m = b.length;
  if (!n || !m) return Infinity;
  // a band keeps the alignment sensible and the cost down: nobody says a name three times slower
  const band = Math.max(Math.abs(n - m), Math.ceil(Math.max(n, m) * 0.4));
  let prev = new Float64Array(m + 1).fill(Infinity), cur = new Float64Array(m + 1);
  let prevLen = new Float64Array(m + 1), curLen = new Float64Array(m + 1);
  prev[0] = 0;
  for (let i = 1; i <= n; i++) {
    cur.fill(Infinity); curLen.fill(0);
    const jc = Math.round((i * m) / n);
    for (let j = Math.max(1, jc - band); j <= Math.min(m, jc + band); j++) {
      let d = 0;
      const x = a[i - 1], y = b[j - 1];
      for (let k = 0; k < x.length; k++) d += (x[k] - y[k]) ** 2;
      d = Math.sqrt(d);
      let best = prev[j - 1], len = prevLen[j - 1];
      if (prev[j] < best) { best = prev[j]; len = prevLen[j]; }
      if (cur[j - 1] < best) { best = cur[j - 1]; len = curLen[j - 1]; }
      cur[j] = best + d;
      curLen[j] = len + 1;
    }
    [prev, cur] = [cur, prev];
    [prevLen, curLen] = [curLen, prevLen];
  }
  return prev[m] / Math.max(1, prevLen[m]);
}

/**
 * Where a name sits inside a longer utterance, and how unlike it is there. Subsequence DTW: the
 * template must be used whole, but it may line up with any stretch of the utterance, so a name
 * is found after "hey", before "run the tests", or with silence either side. The stretch has to
 * be a plausible length for the name (half to twice as long), so a single frame cannot pass for it.
 */
export function locate(utt: number[][], tpl: number[][]): { distance: number; start: number; end: number } {
  const n = utt.length, m = tpl.length;
  const none = { distance: Infinity, start: 0, end: 0 };
  if (!n || !m) return none;
  // per cell: accumulated cost, path length, and the utterance frame the path began at
  let pc = new Float64Array(m + 1), pl = new Float64Array(m + 1), ps = new Int32Array(m + 1);
  let cc = new Float64Array(m + 1), cl = new Float64Array(m + 1), cs = new Int32Array(m + 1);
  pc.fill(Infinity); pc[0] = 0;
  let best = none;
  for (let i = 1; i <= n; i++) {
    cc.fill(Infinity); cc[0] = 0; cl[0] = 0; cs[0] = i; // a path may begin at any frame
    const x = utt[i - 1];
    for (let j = 1; j <= m; j++) {
      const y = tpl[j - 1];
      let d = 0;
      for (let k = 0; k < x.length; k++) d += (x[k] - y[k]) ** 2;
      d = Math.sqrt(d);
      // choose the predecessor with the lowest mean cost so far, not the lowest total: otherwise
      // the shortest path always wins and the alignment cuts corners
      let bc = pc[j - 1], bl = pl[j - 1], bs = j === 1 ? i : ps[j - 1];
      const mean = (c: number, l: number) => (l ? c / l : c);
      if (mean(pc[j], pl[j]) < mean(bc, bl)) { bc = pc[j]; bl = pl[j]; bs = ps[j]; }
      if (mean(cc[j - 1], cl[j - 1]) < mean(bc, bl)) { bc = cc[j - 1]; bl = cl[j - 1]; bs = cs[j - 1]; }
      cc[j] = bc + d; cl[j] = bl + 1; cs[j] = bs;
    }
    const span = i - cs[m] + 1;
    if (span >= m * 0.5 && span <= m * 2) {
      const dist = cc[m] / cl[m];
      if (dist < best.distance) best = { distance: dist, start: cs[m] - 1, end: i };
    }
    [pc, cc] = [cc, pc]; [pl, cl] = [cl, pl]; [ps, cs] = [cs, ps];
  }
  return best;
}

// ---------- templates and matching ----------

export interface VoiceMatch {
  id: string;
  distance: number;
  /** How far a match for this agent may sit, from how consistently the lead says its name. */
  limit: number;
  /** Where in the utterance the name was heard, in ms from the start of its speech. */
  startMs?: number;
  endMs?: number;
  /**
   * "strong": clear enough to trust on the sound alone. "weak": the right shape, but too close
   * to ordinary words to trust unless the transcript also holds something that sounds like the
   * name ("Juneau" for Juno, "Mylo" for Milo). Names glued to a greeting land here most often.
   */
  strength: "strong" | "weak";
}

/** How a teaching session is going, judged after every try. */
export interface TeachAssessment {
  /** Tries that fit together, after any outlier is dropped. */
  kept: number;
  /** The newest try did not sound like the others (a cough, another word): it is not kept. */
  outlier: boolean;
  /** Every kept try sits close to the rest. */
  consistent: boolean;
  /** Another agent whose name sounds like this one in the lead's voice. */
  clash: string | null;
  /** Enough tries that agree. A clash is reported alongside, not held against it. */
  confident: boolean;
  /** 0–1, for a progress bar: the same as confidence. */
  quality: number;
  /**
   * How sure it is of this name, 0–1, rising as more takes agree: how many there are, how tightly
   * they agree, how far they sit from the lead's other names, and how often the recogniser heard
   * the name in them. What the bar on the page shows, so it climbs as the lead keeps saying it.
   */
  confidence: number;
  /** Which of the session's tries are kept, by index: the rest should be let go. */
  keep: number[];
}
export const MIN_TRIES = 3;
/** Learned well enough to use. Teaching goes on past this, to SURE, unless the lead says done. */
export const CONFIDENT = 0.75;
/** So sure there is nothing more to gain: teaching that name finishes by itself. */
export const SURE = 0.92;
export const MAX_TRIES = 8;
const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / Math.max(1, a.length);
const median = (a: number[]) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/**
 * Every judgement here is relative, never against a fixed number. How far apart a lead's own takes
 * of a name sit depends on their voice, their mic, their room and their accent — a fixed limit set
 * on clean recordings would refuse a real person who says "Ada" the same way ten times. So a name is
 * measured against how consistently this lead says it (its spread), and against their other names.
 *
 * The thresholds, as fractions: of the spread of the agent's own templates; of the median distance
 * to every other taught name (the field); of the nearest other name. Chosen from varied recordings —
 * accented and not, different mics, rooms and levels — so that a match trusted on its sound alone
 * lets through about one ordinary word in a hundred, and a weak one is only used with the
 * transcript's backing. Re-measure with scripts/eval-names.ts before changing them.
 */
interface Tier { own: number; field: number; next: number; solo: number }
export const STRONG: Tier = { own: 1.4, field: 0.75, next: 0.8, solo: 1.0 };
export const WEAK: Tier = { own: 1.6, field: 0.85, next: 0.9, solo: 1.4 };

/** How far apart an agent's own templates sit from one another: the measure of everything else. */
export function spreadOf(t: number[][][]): number {
  if (t.length < 2) return 0;
  const ds: number[] = [];
  for (let i = 0; i < t.length; i++) for (let j = i + 1; j < t.length; j++) ds.push(dtw(t[i], t[j]));
  return median(ds);
}

export class Voiceprints {
  private dir: string;
  private prints = new Map<string, number[][][]>();
  private sure = new Set<string>();
  /** Agents whose saved templates predate the current features: they need teaching again. */
  private stale = new Set<string>();
  private spreads = new Map<string, number>();

  constructor(dir: string) {
    this.dir = dir;
  }

  async load(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
    const { readdir } = await import("node:fs/promises");
    for (const f of await readdir(this.dir).catch(() => [] as string[])) {
      if (!f.endsWith(".json")) continue;
      const id = f.slice(0, -5);
      try {
        const t = JSON.parse(await readFile(join(this.dir, f), "utf8"));
        // made with older features: comparing them with today's would give nonsense, so they are
        // set aside, and the page asks the lead to teach that name again
        if (t?.version !== FEATURE_VERSION) { this.stale.add(id); continue; }
        if (Array.isArray(t?.templates)) this.prints.set(id, t.templates);
        if (t?.confident) this.sure.add(id);
      } catch {}
    }
  }

  count(id: string): number {
    return this.prints.get(id)?.length ?? 0;
  }

  /** How many samples of the lead's voice each agent has: the page asks to teach the ones with none. */
  counts(): Record<string, number> {
    return Object.fromEntries([...this.prints].map(([id, t]) => [id, t.length]));
  }

  /** Agents taught before the features changed, who need teaching again. */
  needsRelearning(): string[] {
    return [...this.stale];
  }

  /** Keep these tries as an agent's templates, after the ones it has, up to a few. */
  async add(id: string, tries: number[][][], confident = false): Promise<number> {
    const good = tries.filter((t) => t.length >= 12); // under ~0.12s is a click, not a name
    if (!good.length) return this.count(id);
    const all = [...(this.prints.get(id) ?? []), ...good].slice(-MAX_TEMPLATES);
    this.prints.set(id, all);
    this.spreads.delete(id);
    this.stale.delete(id);
    if (confident) this.sure.add(id); else this.sure.delete(id);
    await mkdir(this.dir, { recursive: true });
    await writeFile(join(this.dir, `${id.replace(/[^\w-]/g, "")}.json`), JSON.stringify({ version: FEATURE_VERSION, templates: all, confident }));
    return all.length;
  }

  /** Agents whose name was learned to confidence, not just partly. */
  confident(): string[] {
    return [...this.sure];
  }

  /**
   * Judge a teaching session after its newest try. Whichever try is the odd one out is dropped —
   * a cough, another word, a false start, wherever in the session it came. What is left is
   * confident once at least three tries agree and no other taught name sounds as close to them as
   * they are to each other. Nothing here is a fixed limit: someone whose takes naturally vary more
   * is held to their own spread, not to a clean recording's.
   */
  assess(id: string, session: number[][][], { recognised }: { recognised?: number } = {}): TeachAssessment {
    let tries = session.filter((t) => t.length >= 12);
    const newest = session[session.length - 1];
    let outlier = !!newest && newest.length < 12;
    // one at a time, the try furthest from the rest, while it is clearly further from them than
    // they are from each other
    while (tries.length >= 3) {
      const far = tries.map((t, i) => mean(tries.filter((_, j) => j !== i).map((u) => dtw(t, u))));
      const worst = far.indexOf(Math.max(...far));
      const rest = tries.filter((_, i) => i !== worst);
      const spread: number[] = [];
      for (let i = 0; i < rest.length; i++) for (let j = i + 1; j < rest.length; j++) spread.push(dtw(rest[i], rest[j]));
      if (far[worst] <= OUTLIER * median(spread)) break;
      if (tries[worst] === newest) outlier = true;
      tries = rest;
    }
    const loo = tries.map((t, i) => mean(tries.filter((_, j) => j !== i).map((u) => dtw(t, u))));
    const own = median(loo);
    const consistent = tries.length >= 2 && loo.every((d) => d <= OUTLIER * own);
    // the lead's other taught names: is any as close to these tries as they are to each other?
    let clash: string | null = null;
    for (const [other, t] of this.prints) {
      if (other === id || !t.length || !tries.length) continue;
      const d = median(tries.map((x) => Math.min(...t.map((y) => dtw(x, y)))));
      if (d < own * CLASH) { clash = other; break; }
    }
    // How sure, from four things, each 0–1:
    //   - how many takes agree, with diminishing returns: 45% after one, 70% two, 83% three, 91% four
    //   - how tightly they agree: the spread of each take's distance to the others
    //   - how far they sit from the lead's other names, relative to their own spread
    //   - how often the recogniser wrote the name itself for these takes, when that is known
    const n = tries.length;
    const sample = 1 - 0.55 ** n;
    const cv = loo.length > 1 ? Math.sqrt(mean(loo.map((d) => (d - mean(loo)) ** 2))) / Math.max(1e-6, mean(loo)) : 0.3;
    const tight = Math.max(0.55, Math.min(1, 1.2 - cv * 1.5));
    let nearest = Infinity;
    for (const [other, t] of this.prints) {
      if (other === id || !t.length || !n) continue;
      nearest = Math.min(nearest, median(tries.map((x) => Math.min(...t.map((y) => dtw(x, y))))));
    }
    // a look-alike lowers it, by at most a fifth: a few more agreeing takes still get there
    const apart = Number.isFinite(nearest) ? Math.max(0.8, Math.min(1, (nearest / Math.max(own, 1e-6) - 1) / 1.2 + 0.6)) : 0.97;
    const heard = recognised === undefined ? 1 : 0.75 + 0.25 * Math.max(0, Math.min(1, recognised));
    const confidence = +(sample * tight * apart * heard).toFixed(2);
    // A clash is worth knowing — two names that sound alike in this voice are easy to mix up — but
    // it is said, not held against the lead: refusing to finish would only leave them saying the
    // name over and over. The matcher's field test keeps the two apart as well as it can.
    const confident = n >= MIN_TRIES && consistent && confidence >= CONFIDENT;
    return { kept: n, outlier, consistent, clash, confident, quality: confidence, confidence, keep: tries.map((t) => session.indexOf(t)) };
  }

  /** Forget an agent's voice: after a rename the old name's sound no longer applies. */
  async clear(id: string): Promise<void> {
    this.prints.delete(id);
    this.spreads.delete(id);
    this.sure.delete(id);
    this.stale.delete(id);
    await rm(join(this.dir, `${id.replace(/[^\w-]/g, "")}.json`), { force: true });
  }

  private spread(id: string): number {
    let s = this.spreads.get(id);
    if (s === undefined) { s = spreadOf(this.prints.get(id) ?? []); this.spreads.set(id, s); }
    return s;
  }

  /**
   * Which agent, if any, this utterance names — said alone, or inside a short phrase.
   *
   * Every agent's templates are looked for anywhere in it (see locate). The best agent must sit
   * within its own spread (scaled), well under the median distance to the lead's other names, and
   * clearly under the nearest one. That last pair is what stops an ordinary word: "okay" may land
   * near a short name like Ada, but about as near every other name too, while a real name sits far
   * closer to its own templates than to anyone else's. With only one name taught there is no field,
   * so its own spread is held more tightly instead.
   */
  match(feats: number[][], among?: Iterable<string>): VoiceMatch | null {
    if (feats.length < 12) return null;
    const ids = among ? [...among] : [...this.prints.keys()];
    const scored: { id: string; distance: number; start: number; end: number }[] = [];
    for (const id of ids) {
      const t = this.prints.get(id);
      if (!t?.length) continue;
      const hits = t.map((x) => locate(feats, x)).sort((a, b) => a.distance - b.distance);
      // the best two templates together: one lucky alignment is not enough
      const top = hits.slice(0, 2).filter((h) => Number.isFinite(h.distance));
      if (!top.length) continue;
      scored.push({ id, distance: top.reduce((a, h) => a + h.distance, 0) / top.length, start: top[0].start, end: top[0].end });
    }
    scored.sort((a, b) => a.distance - b.distance);
    const best = scored[0];
    if (!best) return null;
    const spread = this.spread(best.id);
    const others = scored.slice(1).map((x) => x.distance);
    const passes = (t: Tier) => {
      const ownOk = spread > 0 ? best.distance <= spread * (others.length ? t.own : t.solo) : others.length > 0;
      if (!others.length) return ownOk;
      return ownOk && best.distance <= median(others) * t.field && best.distance <= others[0] * t.next;
    };
    const strength = passes(STRONG) ? "strong" : passes(WEAK) ? "weak" : null;
    if (!strength) return null;
    const limit = spread * (strength === "strong" ? STRONG.own : WEAK.own);
    return { id: best.id, distance: best.distance, limit, startMs: best.start * 10, endMs: best.end * 10, strength };
  }
}
/** A try further than this many times the others' spread from them is the odd one out. */
const OUTLIER = 1.8;
/** Another name this close (relative to the takes' own spread) clashes with the one being taught. */
const CLASH = 1.1;

export const durationMs = (audio: Float32Array) => (tighten(audio, 0, 0, 0.07).length / RATE) * 1000;

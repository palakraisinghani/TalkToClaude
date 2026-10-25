import { AutoProcessor, AutoTokenizer, pipeline, WhisperForConditionalGeneration } from "@huggingface/transformers";
import type { STT, TranscribeOptions } from "./types.ts";

/**
 * Which recogniser to run. Measured on names said in Indian and other English accents, each take
 * varied the way a real mic and room vary it (see scripts/eval-names.ts):
 *
 *   recogniser                      Indian accent: name right   others   per utterance
 *   Moonshine base                          30%                  53%       ~0.05s
 *   Whisper base.en, team's names           84%                  92%       ~0.45s
 *   Whisper small.en, team's names          92%                  95%       ~1.0s
 *
 * Whisper was trained on far more accents, and it takes a prompt: given the team's names, it writes
 * "Ada" where Moonshine wrote "He had a" or nothing at all. Telling it the accent in words made no
 * difference; the names are what count. "fast" is the default; "accurate" is worth its extra half
 * second for a strong accent.
 */
export const RECOGNISERS = {
  fast: "onnx-community/whisper-base.en",
  accurate: "onnx-community/whisper-small.en",
  moonshine: "onnx-community/moonshine-base-ONNX",
} as const;
export type RecogniserName = keyof typeof RECOGNISERS;

export function makeSTT(which: string = process.env.BUDDY_STT_MODEL ?? "fast"): STT {
  const model = (RECOGNISERS as Record<string, string>)[which] ?? which;
  return /moonshine/i.test(model) ? new MoonshineSTT(model) : new WhisperSTT(model);
}

/**
 * Whisper, run on this machine's CPU, prompted with the names on the call. A prompt is Whisper's
 * way of being told what came before; the names in it make those words the likely reading of a
 * sound that could be several things. It is passed as decoder tokens, since the library does not
 * wire up its own prompt option.
 */
export class WhisperSTT implements STT {
  private ready_: Promise<{ processor: any; tokenizer: any; model: any }>;
  private chain: Promise<unknown> = Promise.resolve();
  readonly model: string;

  constructor(model: string = RECOGNISERS.fast) {
    this.model = model;
    this.ready_ = (async () => {
      const [processor, tokenizer, m] = await Promise.all([
        AutoProcessor.from_pretrained(model),
        AutoTokenizer.from_pretrained(model),
        WhisperForConditionalGeneration.from_pretrained(model, { dtype: "q8" }),
      ]);
      return { processor, tokenizer, model: m };
    })();
  }

  async ready(): Promise<void> {
    await this.transcribe(new Float32Array(16000)); // first call compiles the graph; do it before anyone talks
  }

  transcribe(audio: Float32Array, opts: TranscribeOptions = {}): Promise<string> {
    const job = this.chain.then(async () => {
      // Whisper invents words for silence and noise ("Thank you.", "This is the first time I've
      // ever seen a video."): only clips that hold speech are given to it at all
      if (!hasSpeech(audio)) return "";
      const { processor, tokenizer, model } = await this.ready_;
      const cfg = model.generation_config;
      const special = (t: string) => tokenizer.encode(t, { add_special_tokens: false })[0];
      const names = [...new Set((opts.names ?? []).filter(Boolean))].slice(0, 24);
      const prompt = names.length ? [special("<|startofprev|>"), ...tokenizer.encode(` ${names.join(", ")}.`, { add_special_tokens: false })] : [];
      const lang = cfg.is_multilingual ? [special("<|en|>"), special("<|transcribe|>")] : [];
      const prefix = [...prompt, cfg.decoder_start_token_id, ...lang, cfg.no_timestamps_token_id];
      const clip = tighten(audio);
      const { input_features } = await processor(clip);
      // no more words than could fit in the clip: a short "Kai" cannot be forty words, and capping
      // it stops Whisper's habit of looping ("I mean, I mean, …") from costing seconds
      const seconds = clip.length / RATE;
      const out = await model.generate({ inputs: input_features, decoder_input_ids: [prefix], max_new_tokens: Math.min(160, Math.round(seconds * 9) + 10) });
      const ids = (out.tolist ? out.tolist()[0] : out[0]).map(Number).slice(prefix.length);
      return unhallucinate(tokenizer.decode(ids, { skip_special_tokens: true }).trim(), names, seconds);
    });
    this.chain = job.catch(() => {});
    return job;
  }
}

/** Stock phrases Whisper produces from noise, learned from subtitles; never something said here. */
const HALLUCINATIONS = [
  /^this is the first time i'?ve ever seen a video\.?$/i, /^thanks? (you )?for watching[.!]?$/i, /^please subscribe[.!]?$/i,
  /^subtitles? by\b/i, /^(\[|\()?(music|applause|silence|blank_audio|inaudible)(\]|\))?\.?$/i, /^tch[.,!]?$/i, /^you\.?$/i,
];
/** Whisper's reading, minus its known inventions and any echo of the prompt. */
export function unhallucinate(text: string, names: string[] = [], seconds = Infinity): string {
  let t = text.trim();
  if (HALLUCINATIONS.some((re) => re.test(t))) return "";
  // a phrase repeated over and over is Whisper looping, not the lead: keep it once
  t = t.replace(/\b(\w+(?:[ ,]+\w+){0,3})(?:[ ,.]+\1\b){2,}/gi, "$1");
  // more words than anyone could say in the clip were invented: people manage about four a second
  const words = t.split(/\s+/).filter(Boolean).length;
  if (seconds < 30 && words > Math.max(4, seconds * 5)) return "";
  // the prompt read back, word for word, is the prompt and not the lead
  const flat = (x: string) => x.toLowerCase().replace(/[^a-z]+/g, " ").trim();
  if (names.length > 2 && flat(t) === flat(names.join(" "))) return "";
  return t;
}

/**
 * Does this clip hold speech? Its loud frames must stand well clear of its quiet ones (about 12 dB):
 * a VAD segment always has some quiet around the words, while steady noise has no such contrast.
 */
export function hasSpeech(audio: Float32Array): boolean {
  const F = 400, n = Math.floor(audio.length / F);
  if (n < 5) return false;
  const rms: number[] = [];
  for (let f = 0; f < n; f++) { let e = 0; for (let i = f * F; i < (f + 1) * F; i++) e += audio[i] * audio[i]; rms.push(Math.sqrt(e / F)); }
  rms.sort((x, y) => x - y);
  const quiet = rms[Math.floor(n * 0.1)], loud = rms[Math.floor(n * 0.95)];
  return loud > 1e-3 && loud >= quiet * 4;
}

/** Moonshine running on this machine's CPU via transformers.js. No key, no extra server. */
export class MoonshineSTT implements STT {
  private asr: Promise<any>;
  private chain: Promise<unknown> = Promise.resolve();

  constructor(model = process.env.BUDDY_STT_MODEL ?? "onnx-community/moonshine-base-ONNX") {
    this.asr = pipeline("automatic-speech-recognition", model, { dtype: "q8" });
  }

  async ready(): Promise<void> {
    const asr = await this.asr;
    await asr(new Float32Array(16000)); // first call compiles the graph; do it before anyone talks
  }

  transcribe(audio: Float32Array, _opts: TranscribeOptions = {}): Promise<string> {
    // one utterance at a time keeps CPU use predictable
    const job = this.chain.then(async () => {
      const asr = await this.asr;
      const out = await asr(tighten(audio));
      return String(out?.text ?? "").trim();
    });
    this.chain = job.catch(() => {});
    return job;
  }
}

const RATE = 16000;
const FRAME = 320; // 20ms

/**
 * Cut the quiet off both ends of an utterance, keeping a short margin. Moonshine often returns
 * nothing for a short word sitting in a long stretch of silence, and the voice detector hands
 * over exactly that: its lead-in plus the pause it waited through to be sure you had stopped.
 * Measured on "Ada" synthesized in seventeen voices and padded the way the detector pads it,
 * half came back empty untrimmed and under one in ten trimmed. Loudness is judged per 20ms frame
 * against the loudest; the bar is low so a quieter second syllable ("A-da") is not cut off.
 */
export function tighten(audio: Float32Array, marginMs = 250, minMs = 600, barRatio = 0.07): Float32Array {
  const frames = Math.floor(audio.length / FRAME);
  if (frames < 3) return pad(audio, minMs);
  const rms = new Float32Array(frames);
  let loudest = 0;
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += audio[i] * audio[i];
    rms[f] = Math.sqrt(sum / FRAME);
    if (rms[f] > loudest) loudest = rms[f];
  }
  if (loudest < 1e-4) return pad(audio, minMs); // silence: nothing to find
  const bar = loudest * barRatio;
  let first = 0, last = frames - 1;
  while (first < last && rms[first] < bar) first++;
  while (last > first && rms[last] < bar) last--;
  const margin = Math.round((marginMs / 1000) * RATE);
  const start = Math.max(0, first * FRAME - margin), end = Math.min(audio.length, (last + 1) * FRAME + margin);
  return pad(audio.subarray(start, end), minMs);
}

/** Too short a clip crashes the model's first convolution: centre it in a little silence. */
function pad(audio: Float32Array, minMs: number): Float32Array {
  const min = Math.round((minMs / 1000) * RATE);
  if (audio.length >= min) return audio;
  const out = new Float32Array(min);
  out.set(audio, Math.floor((min - audio.length) / 2));
  return out;
}

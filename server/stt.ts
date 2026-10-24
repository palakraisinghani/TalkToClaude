import { pipeline } from "@huggingface/transformers";
import type { STT } from "./types.ts";

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

  transcribe(audio: Float32Array): Promise<string> {
    // one utterance at a time keeps CPU use predictable
    const job = this.chain.then(async () => {
      const asr = await this.asr;
      const out = await asr(audio);
      return String(out?.text ?? "").trim();
    });
    this.chain = job.catch(() => {});
    return job;
  }
}

// A short two-note motif, played from a project's own side of your head before it speaks.
//
// speechSynthesis plays straight to the output device and cannot be routed through WebAudio, so
// the voice itself cannot be panned. The earcon can, and it carries the spatial cue: a tone from
// the left means Ada is about to talk, and you know who before you know what. Swapping in a
// neural voice behind the TTS interface would let the speech itself be placed the same way.

const ATTACK = 0.012;
const NOTE = 0.085;

export class Earcons {
  constructor(ctx) {
    this.ctx = ctx;
    this.gain = 0.09;
    this.enabled = true;
  }

  /** Play identity.earcon at identity.pan. Resolves when the motif has finished. */
  async play(identity) {
    const ctx = this.ctx;
    if (!this.enabled || !ctx || !identity?.earcon) return;
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch { return; } }
    const [a, b] = identity.earcon;
    const pan = Math.max(-1, Math.min(1, identity.pan ?? 0));
    const t0 = ctx.currentTime + 0.01;
    // one panner for the motif; browsers without StereoPanner fall back to centre
    const out = ctx.createGain();
    out.gain.value = 1;
    const panner = ctx.createStereoPanner?.();
    if (panner) { panner.pan.value = pan; out.connect(panner); panner.connect(ctx.destination); }
    else out.connect(ctx.destination);
    [a, b].forEach((hz, i) => {
      const osc = ctx.createOscillator();
      const g = ctx.createGain();
      osc.type = "sine";
      osc.frequency.value = hz;
      const start = t0 + i * NOTE;
      g.gain.setValueAtTime(0, start);
      g.gain.linearRampToValueAtTime(this.gain, start + ATTACK);
      g.gain.exponentialRampToValueAtTime(0.0001, start + NOTE);
      osc.connect(g);
      g.connect(out);
      osc.start(start);
      osc.stop(start + NOTE + 0.02);
    });
    await new Promise((r) => setTimeout(r, NOTE * 2 * 1000 + 30));
  }
}

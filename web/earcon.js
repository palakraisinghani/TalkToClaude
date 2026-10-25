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
    this.ringEnabled = true;
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

  /**
   * The notification ring: a soft, bell-like three-note chime that says "something is waiting
   * for you" without saying what. It is played the moment news arrives, even mid-conversation,
   * and is deliberately unlike any earcon so it is never mistaken for someone about to speak.
   */
  async ring(identity = null) {
    const ctx = this.ctx;
    if (!this.ringEnabled || !ctx) return;
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch { return; } }
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = 0.07;
    // it comes from the side of the project with the news, so on headphones you know who before
    // anyone says so
    const panner = ctx.createStereoPanner?.();
    if (panner) { panner.pan.value = Math.max(-1, Math.min(1, identity?.pan ?? 0)); out.connect(panner); panner.connect(ctx.destination); }
    else out.connect(ctx.destination);
    // a bell: a fundamental plus a quiet inharmonic partial, each with a long soft decay
    [1318.5, 1568, 2093].forEach((hz, i) => {
      const start = t0 + i * 0.13;
      for (const [mult, level] of [[1, 1], [2.76, 0.18]]) {
        const osc = ctx.createOscillator();
        const g = ctx.createGain();
        osc.type = "sine";
        osc.frequency.value = hz * mult;
        g.gain.setValueAtTime(0, start);
        g.gain.linearRampToValueAtTime(level, start + 0.006);
        g.gain.exponentialRampToValueAtTime(0.0001, start + 0.55);
        osc.connect(g);
        g.connect(out);
        osc.start(start);
        osc.stop(start + 0.6);
      }
    });
    await new Promise((r) => setTimeout(r, 900));
  }

  /**
   * Short cues for teaching a name, so it can be done without looking: a soft rising blip when a
   * try was kept, a low tone when it was not, and a rising three-note figure when the name is
   * learned. All far shorter than anything the mic would take for speech.
   */
  async cue(kind) {
    const ctx = this.ctx;
    if (!ctx) return;
    if (ctx.state === "suspended") { try { await ctx.resume(); } catch { return; } }
    const notes = { kept: [[880, 0], [1175, 0.07]], dropped: [[330, 0], [294, 0.09]], learned: [[784, 0], [988, 0.09], [1319, 0.18]] }[kind];
    if (!notes) return;
    const t0 = ctx.currentTime + 0.01;
    const out = ctx.createGain();
    out.gain.value = kind === "dropped" ? 0.06 : 0.05;
    out.connect(ctx.destination);
    for (const [hz, at] of notes) {
      const osc = ctx.createOscillator(), g = ctx.createGain();
      osc.type = kind === "dropped" ? "triangle" : "sine";
      osc.frequency.value = hz;
      g.gain.setValueAtTime(0, t0 + at);
      g.gain.linearRampToValueAtTime(1, t0 + at + 0.008);
      g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.11);
      osc.connect(g); g.connect(out);
      osc.start(t0 + at); osc.stop(t0 + at + 0.13);
    }
  }
}

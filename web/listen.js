// Buddy's ears: Silero VAD in the browser decides when you start and stop talking and hands
// over the whole utterance as audio; the server transcribes it. Falls back to Chrome's own
// recognizer if the VAD cannot load.

// How readily the mic decides you are talking. "low" is for a noisy room: a cough or a door is
// less likely to count, at the cost of needing to speak up a little.
export const SENSITIVITY = {
  low: { positiveSpeechThreshold: 0.7, negativeSpeechThreshold: 0.5, minSpeechMs: 400 },
  normal: { positiveSpeechThreshold: 0.55, negativeSpeechThreshold: 0.38, minSpeechMs: 300 },
  high: { positiveSpeechThreshold: 0.42, negativeSpeechThreshold: 0.28, minSpeechMs: 220 },
};
// Silero v5 judges 512-sample frames at 16 kHz.
const FRAME_MS = 32;

export async function createVadListener({ onSpeechStart, onSpeechEnd, onMisfire, onLevel, processorType = "auto", audioContext, sensitivity = "normal" }) {
  if (!window.vad) throw new Error("VAD library did not load");
  let level = SENSITIVITY[sensitivity] ?? SENSITIVITY.normal;
  let strict = false;
  // how much of the current segment the detector was confident was a voice: a cough is loud but
  // brief, a word is sustained, and this is what tells them apart once the transcript is back
  let voicedFrames = 0;
  const options = () => strict
    ? { ...level, positiveSpeechThreshold: Math.min(0.9, level.positiveSpeechThreshold + 0.2), minSpeechMs: level.minSpeechMs + 150 }
    : level;
  const vad = await window.vad.MicVAD.new({
    model: "v5",
    baseAssetPath: "/vendor/vad/",
    onnxWASMBasePath: "/vendor/ort/",
    startOnLoad: false,
    audioContext, // created inside the click handler so Safari lets it run
    processorType, // "ScriptProcessor" for browsers without a working AudioWorklet (e.g. headless test runs)
    getStream: () => navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    }),
    ...level,
    redemptionMs: 900, // this much silence ends your turn; short pauses mid-sentence do not
    preSpeechPadMs: 400,
    onSpeechStart: () => { voicedFrames = 0; onSpeechStart(); },
    onSpeechEnd: (audio) => onSpeechEnd(toInt16(audio), voicedFrames * FRAME_MS),
    onVADMisfire: onMisfire,
    onFrameProcessed: (p) => {
      if (p.isSpeech >= options().positiveSpeechThreshold) voicedFrames++;
      onLevel?.(p.isSpeech);
    },
  });
  return {
    kind: "vad",
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => vad.destroy(),
    /** Raise the bar while Buddy talks out of speakers so its own voice does not count as you. */
    strict: (on) => { if (on === strict) return; strict = on; vad.setOptions(options()); },
    sensitivity: (name) => { level = SENSITIVITY[name] ?? SENSITIVITY.normal; vad.setOptions(options()); },
  };
}

export function createChromeListener({ onSpeechStart, onText }) {
  const R = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!R) throw new Error("No speech recognition available in this browser");
  let on = false, r = null, live = false;
  const open = () => {
    r = new R();
    r.lang = "en-US"; r.continuous = true; r.interimResults = true;
    r.onstart = () => (live = true);
    r.onend = () => (live = false);
    let started = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++) {
        const res = e.results[i];
        if (!started) { started = true; onSpeechStart(); }
        if (res.isFinal) { started = false; onText(res[0].transcript.trim()); }
      }
    };
    try { r.start(); } catch {}
  };
  const watchdog = setInterval(() => { if (on && !live) open(); }, 800);
  return {
    kind: "chrome",
    start: () => { on = true; open(); },
    pause: () => { on = false; try { r?.abort(); } catch {} },
    destroy: () => { on = false; clearInterval(watchdog); try { r?.abort(); } catch {} },
    strict: () => {},
    sensitivity: () => {},
  };
}

function toInt16(f32) {
  const out = new Int16Array(f32.length);
  for (let i = 0; i < f32.length; i++) out[i] = Math.max(-1, Math.min(1, f32[i])) * 0x7fff;
  return out;
}

// Buddy's ears: Silero VAD in the browser decides when you start and stop talking and hands
// over the whole utterance as audio; the server transcribes it. Falls back to Chrome's own
// recognizer if the VAD cannot load.

// How readily the mic decides you are talking. "low" is for a noisy room: a cough or a door is
// less likely to count, at the cost of needing to speak up a little.
export const SENSITIVITY = {
  low: { positiveSpeechThreshold: 0.7, negativeSpeechThreshold: 0.5, minSpeechMs: 400 },
  // a name said on its own ("Ada") is about a quarter of a second; the minimum must let it through
  normal: { positiveSpeechThreshold: 0.55, negativeSpeechThreshold: 0.38, minSpeechMs: 250 },
  high: { positiveSpeechThreshold: 0.42, negativeSpeechThreshold: 0.28, minSpeechMs: 220 },
};
// Silero v5 judges 512-sample frames at 16 kHz.
const FRAME_MS = 32;
// While a voice plays out of speakers, the mic hears it as speech without a pause, so a segment
// would not end until the voice did. Cut it this often instead, so an interruption is heard now.
const FLUSH_MS = 2500;

export async function createVadListener({ onSpeechStart, onSpeechEnd, onMisfire, onLevel, processorType = "auto", audioContext, sensitivity = "normal" }) {
  if (!window.vad) throw new Error("VAD library did not load");
  let level = SENSITIVITY[sensitivity] ?? SENSITIVITY.normal;
  let strict = false;
  // how much of the current segment the detector was confident was a voice: a cough is loud but
  // brief, a word is sustained, and this is what tells them apart once the transcript is back
  let voicedFrames = 0;
  let segmentAt = 0;
  let vad = null;
  let stream = null; // the microphone, kept so it can be checked: a dead one is reopened (app.js)
  const options = () => strict
    ? { ...level, positiveSpeechThreshold: Math.min(0.9, level.positiveSpeechThreshold + 0.1), minSpeechMs: level.minSpeechMs + 50 }
    : level;
  vad = await window.vad.MicVAD.new({
    model: "v5",
    baseAssetPath: "/vendor/vad/",
    onnxWASMBasePath: "/vendor/ort/",
    startOnLoad: false,
    audioContext, // created inside the click handler so Safari lets it run
    processorType, // "ScriptProcessor" for browsers without a working AudioWorklet (e.g. headless test runs)
    getStream: async () => (stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    })),
    ...level,
    redemptionMs: 900, // this much silence ends your turn; short pauses mid-sentence do not
    preSpeechPadMs: 400,
    onSpeechStart: () => { voicedFrames = 0; segmentAt = Date.now(); onSpeechStart(); },
    onSpeechEnd: (audio) => { segmentAt = 0; onSpeechEnd(toInt16(audio), voicedFrames * FRAME_MS); },
    onVADMisfire: () => { segmentAt = 0; onMisfire(); },
    onFrameProcessed: (p) => {
      if (p.isSpeech >= options().positiveSpeechThreshold) voicedFrames++;
      onLevel?.(p.isSpeech);
      // frameProcessor is the library's own; if a version drops it, segments just run long again
      if (strict && segmentAt && Date.now() - segmentAt > FLUSH_MS && vad?.frameProcessor?.endSegment) {
        segmentAt = 0;
        vad.frameProcessor.endSegment(vad.handleFrameProcessorEvent);
      }
    },
  });
  return {
    kind: "vad",
    start: () => vad.start(),
    pause: () => vad.pause(),
    destroy: () => { vad.destroy(); stream?.getTracks().forEach((t) => t.stop()); },
    /** Is the microphone still delivering sound? Ended (unplugged, taken by another app) it is not. */
    live: () => !stream || stream.getAudioTracks().some((t) => t.readyState === "live"),
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

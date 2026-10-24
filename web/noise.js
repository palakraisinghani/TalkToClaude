// Telling a cough from a word.
//
// The browser's noise suppression takes out steady noise — fans, hum, traffic — but not a cough,
// a sneeze, a laugh or a door: those are short and loud, and the voice detector briefly takes
// them for speech. The speech recognizer then does its best with them, and its best is a filler
// ("Uh."), a stock phrase it learned from subtitles ("Thank you."), or a stage direction
// ("[coughs]"). So a segment is judged on two things together: how much of it actually sounded
// like a voice, and whether what came back is a real word.
//
// A short command must still get through, because "stop" and "pause" are short too. So anything
// that is a page command, or a name on the call, is never thrown away here.

const FILLERS = new Set([
  "uh", "uhh", "um", "umm", "hmm", "hm", "mm", "mmm", "mhm", "ah", "ahh", "oh", "er", "erm", "eh",
  "huh", "ha", "haha", "heh", "ugh", "ow", "oops", "achoo", "cough", "coughs", "coughing", "sneeze",
  "sneezes", "laugh", "laughs", "sigh", "sniff", "clears", "throat",
]);

// what the recognizer says when it hears a noise and has to say something
const PHANTOMS = new Set([
  "you", "the", "a", "i", "so", "and", "thank you", "thanks", "thanks for watching", "bye", "okay bye",
  "please subscribe", "music", "applause", "silence", "noise", "inaudible", "blank audio",
]);

const norm = (t) => t.toLowerCase().replace(/[^\w' ]/g, " ").replace(/\s+/g, " ").trim();

/** Below this much voiced sound, a segment has to prove it was speech by what it says. */
export const MIN_VOICED_MS = 380;

/**
 * Is this transcript a noise rather than something said?
 * `voicedMs`: how long the voice detector was confident it heard a voice in this segment.
 * `keep`: things that must always get through, however short (page commands, names).
 */
export function isNoise(text, voicedMs = Infinity, keep = () => false) {
  const raw = (text ?? "").trim();
  // a stage direction and nothing else: "[coughs]", "(laughs)", "*sneeze*"
  if (/^[\[(*♪].*[\])*♪]$/.test(raw) && !/[\])*♪].*[\[(*♪]/.test(raw.slice(1, -1))) return true;
  const t = norm(raw.replace(/\[[^\]]*\]|\([^)]*\)/g, " "));
  if (!t) return true;
  if (keep(t)) return false;
  const words = t.split(" ");
  if (words.every((w) => FILLERS.has(w))) return true;
  // a brief burst that came back as a stock phrase, or as one or two throwaway words
  if (voicedMs < MIN_VOICED_MS) {
    if (PHANTOMS.has(t)) return true;
    if (words.length <= 2 && words.every((w) => FILLERS.has(w) || PHANTOMS.has(w) || w.length <= 2)) return true;
  }
  // with almost no voice in it at all, nothing short is trusted
  if (voicedMs < 160 && words.length <= 2) return true;
  return false;
}

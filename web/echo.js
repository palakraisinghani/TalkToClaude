// Telling Buddy's own voice, arriving back through the speakers, apart from the person talking.
//
// Echo reaches the mic as a near-verbatim run of the words Buddy just said, so it is recognised
// by matching ordered word pairs against what was actually uttered. Plain set membership would
// not do: within a sentence or two Buddy has said "the", "it", "is" and "that", and from then on
// any short, genuine reply made of common words scores as an echo.

export const words = (t) => t.toLowerCase().replace(/[^\w ]/g, " ").split(/\s+/).filter(Boolean);

function pairs(w) {
  const s = new Set();
  for (let i = 1; i < w.length; i++) s.add(w[i - 1] + " " + w[i]);
  return s;
}

/**
 * How much of an utterance sits inside a word pair Buddy actually spoke: 1 when every pair
 * matched, 0 when nothing beyond isolated words did. A dropped word in the middle of a long
 * echo costs only the pairs around it, so transcription slips do not hide an echo.
 */
export function echoScore(utterance, spokenText) {
  const u = words(utterance);
  if (u.length < 2) return 0;
  const said = pairs(words(spokenText));
  if (!said.size) return 0;
  const covered = new Array(u.length).fill(false);
  for (let i = 1; i < u.length; i++) {
    if (said.has(u[i - 1] + " " + u[i])) covered[i - 1] = covered[i] = true;
  }
  return covered.filter(Boolean).length / u.length;
}

export const ECHO_THRESHOLD = 0.7;

export const isEchoOf = (utterance, spokenText) => echoScore(utterance, spokenText) >= ECHO_THRESHOLD;

/**
 * What is left of an utterance once Buddy's own words are taken out of it. Talking over a voice
 * on speakers puts both in one recording: "the build passed and wait stop that" is an echo with
 * an interruption in it, and throwing the whole thing away loses the interruption. Only runs of
 * at least `minRun` words that Buddy actually said in that order are removed, so a person who
 * happens to repeat a short phrase of its, three words or fewer, keeps it.
 */
export function stripEcho(utterance, spokenText, minRun = 4) {
  const raw = utterance.trim().split(/\s+/).filter(Boolean);
  const u = raw.map((w) => w.toLowerCase().replace(/[^\w]/g, ""));
  const said = pairs(words(spokenText));
  if (u.length < 2 || !said.size) return utterance.trim();
  const covered = new Array(u.length).fill(false);
  for (let i = 1; i < u.length; i++) {
    if (u[i - 1] && u[i] && said.has(u[i - 1] + " " + u[i])) covered[i - 1] = covered[i] = true;
  }
  const keep = [];
  for (let i = 0; i < u.length; ) {
    let j = i;
    while (j < u.length && covered[j] === covered[i]) j++;
    if (!covered[i] || j - i < minRun) keep.push(...raw.slice(i, j));
    i = j;
  }
  return keep.join(" ");
}

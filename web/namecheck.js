// Will this be easy to call out loud? A quick read of a name, before an agent is given it.
//
// Measured on forty-odd names said in four voices, Indian-English and not, with tempo, pitch and
// tone drifting the way they do in real speech (scripts/eval-names.ts): some names came through
// every time and some barely more than half. The ones that failed shared a few traits, and those
// are what this looks for:
//
//   - a vowel start running into a soft middle sound — Ada, Ava, Ida, Tara: a little drift and they
//     are heard as "Bada", "Awa", "Dada";
//   - one short open syllable — Kai, heard as "hi" and "bye";
//   - sounding like an everyday word — Bolt, heard as "bold" and "vault";
// while the ones that never failed (Atlas, Arjun, Priya, Iris, Max, Jett) have strong, distinct
// consonants and two or three clear syllables. It is advice, never a rule: the lead can use any name.

import { sound, confusable, LOCAL } from "./route.js";
import { COMMON_WORDS } from "./words.js";

const VOWEL = /[aeiouy]/;
const SOFT = /^[dv]$/; // measured: "Ada", "Ava" blurred; "Otto", "Iris", "Orion" did not
// words a short name is most often turned into, beyond the common-word list
const NEAR_MISSES = ["hi", "bye", "hey", "bold", "vault", "other", "order", "either", "steve", "lee", "good", "eat", "sure", "true", "near", "key", "day", "me", "you", "now"];
const COMMANDS = ["next", "stop", "yes", "no", "done", "back", "pause", "skip", "later", "bye", "okay", "status", "repeat"];

/** Rough syllable count: groups of vowels, a silent final e not counted. */
export function syllables(word) {
  // a y between vowels is a consonant ("Pri-ya"), and a final silent e is not a syllable
  const w = word.toLowerCase().replace(/[^a-z]/g, "").replace(/e$/, "").replace(/([aeiou])y(?=[aeiou])/g, "$1-");
  return Math.max(1, (w.match(/[aeiouy]+/g) ?? []).length);
}

/**
 * Rate a name for calling out loud. Returns a score from 0 to 100, a one-word verdict ("good",
 * "okay", "weak"), and the reasons, in words, with a suggestion when it is weak.
 */
export function rateName(name, others = []) {
  const n = String(name ?? "").trim();
  const w = n.toLowerCase().replace(/[^a-z]/g, "");
  if (!w) return { score: 0, verdict: "weak", reasons: ["Give it a name to say."] };
  let score = 85;
  const reasons = [];
  const syl = syllables(w);

  // sounds like another agent, or like a command: the costliest mistakes, a misroute
  const clash = confusable(n, others);
  if (clash) { score -= 40; reasons.push(`It sounds like ${clash}, so the two would get mixed up.`); }
  if (COMMANDS.includes(w) || LOCAL.some((re) => re.test(w))) { score -= 45; reasons.push(`"${n}" is also something you say to the app, so calling it would be taken as a command.`); }

  // a vowel start running into a soft middle sound blurs as tempo and pitch drift
  const vowelStart = VOWEL.test(w[0]);
  const second = w.slice(1).match(/[^aeiouy]/)?.[0] ?? "";
  if (vowelStart && SOFT.test(second) && syl <= 3) { score -= 28; reasons.push(`It starts with a vowel and a soft "${second}", which blur when you speak faster or slower ("Ada" is often heard as "Bada" or "other").`); }
  else if (vowelStart && syl === 1) { score -= 15; reasons.push("It is a single sound starting with a vowel, which is easy to miss."); }
  if (!vowelStart && /^[^aeiouy][aeiouy][td][aeiouy]$/.test(w)) { score -= 12; reasons.push(`The "${w[2]}" between two vowels softens in quick speech ("Tara" heard as "Dada").`); }

  // one short open syllable is easily some everyday word
  if (syl === 1 && /[aeiouy]$/.test(w)) { score -= 25; reasons.push("One short syllable with a soft ending is easy to hear as \"hi\" or \"bye\"."); }

  // sounding like a word the recognizer would rather write ("Bolt" → "bold"): only the near misses
  // seen in measurement, matched on sound — a looser test flagged good names like Priya and Iris
  const target = sound(w);
  const near = NEAR_MISSES.find((c) => c !== w && sound(c) === target);
  if (COMMON_WORDS.has(w)) { score -= 20; reasons.push(`"${n}" is an everyday word, so it will be heard in ordinary sentences.`); }
  else if (near) { score -= 18; reasons.push(`It sounds like the everyday word "${near}", which the recognizer may write instead.`); }

  // strong, distinct consonants and two or three syllables survive drift
  const strong = new Set(w.match(/x|j|z|sh|ch|k|p|g|s|f|b/g) ?? []).size;
  if (strong) score += Math.min(10, strong * 5);
  if (syl === 2 || syl === 3) score += 5;
  if (syl >= 4) { score -= 10; reasons.push("It is long to say every time you want this agent."); }

  score = Math.max(0, Math.min(100, score));
  const verdict = score >= 75 ? "good" : score >= 55 ? "okay" : "weak";
  if (verdict === "good" && !reasons.length) reasons.push("Clear consonants and distinct syllables: it should be easy to pick out, even said quickly or in a different tone.");
  if (verdict === "weak") reasons.push(`Names like Atlas, Priya, Max or Jett come through far more reliably.`);
  return { score, verdict, reasons };
}

const POOL = ["Atlas", "Priya", "Jasper", "Felix", "Arjun", "Dexter", "Oscar", "Rocket", "Sage", "Jett", "Max", "Ziggy", "Pixel", "Kiran", "Zara", "Iris", "Otto", "Rohan", "Nova", "Orion"];
/** A few names that rate well and stay clear of the ones already on the call. */
export function suggestNames(others = [], count = 3) {
  return POOL.filter((n) => !others.some((o) => o.toLowerCase() === n.toLowerCase()) && rateName(n, others).verdict === "good").slice(0, count);
}

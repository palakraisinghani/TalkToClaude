// When has the lead finished? A pause of a second used to end the turn, so a prompt said with a
// breath in the middle reached the agent in pieces and it answered the first half. What was said
// now waits a moment before it is sent — longer when it sounds unfinished — and what is added
// meanwhile joins it (app.js). This decides how long.

import { route, LOCAL } from "./route.js";
import { classify } from "./attention.js";

const norm = (t) => t.toLowerCase().replace(/[^\w' ]/g, " ").replace(/\s+/g, " ").trim();
/** Ends that leave the sentence hanging: "…and", "…with the", "…um", a trailing comma. */
const UNFINISHED = /(?:\b(?:and|or|but|so|because|then|also|with|for|to|of|the|a|an|my|your|that|which|if|when|like|um+|uh+|er+|plus|into|from|on|in|at|about)|,)\s*$/i;

/**
 * Milliseconds to wait for more before sending `text`: 0 for a command or a yes/no (at once), a
 * short beat after a finished sentence, longer when it sounds unfinished.
 */
export function thoughtWait(text, projects = [], { awaiting = false } = {}) {
  const raw = String(text ?? "").trim();
  const t = norm(raw);
  if (!t) return 0;
  // yes, no, stop, pause, a name on its own: at once ("Ada, start a project for…" still waits)
  if (LOCAL.some((re) => re.test(t)) || classify(t) !== null || projects.some((p) => t === norm(p.name))) return 0;
  const r = route(raw, projects);
  if (r.kind !== "ask" && r.kind !== "address") return 0; // a command to the page
  if (UNFINISHED.test(raw) || !/[.!?]["')\]]*\s*$/.test(raw)) return 1800;
  return awaiting ? 500 : 700;
}

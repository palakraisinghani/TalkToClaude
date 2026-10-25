// Deciding who a spoken line is for.
//
// Only one project is on the line at a time, so everything you say goes either to the central
// voice (Buddy) or to that one project. A line addressed to another project by name moves the
// line to them and takes the rest as the question: "Ada, run the tests".
//
// Names are matched EXACTLY when they carry a command, and only loosely when the whole line is
// just a name. A misheard name must never redirect an instruction: falling through to whoever
// is already on the line is the safe failure, because that is who you were talking to.

const norm = (t) => t.toLowerCase().replace(/[^\w' ]/g, " ").replace(/\s+/g, " ").trim();

export const PAUSE = /^(pause|pause please|please pause|hold on|hold up|wait|wait a (sec|second|moment|minute)|one sec(ond)?|hang on|just a (sec|second|moment))$/;
export const RESUME = /^(go on|go ahead|continue|resume|carry on|keep going|okay go on|ok go on|yes go on|please continue|unpause)$/;
export const STOP = /^(stop|stop it|stop talking)$/;
// ends the call outright, from anywhere on it
export const SLEEP = /^(go to sleep|bye|goodbye|good bye|bye bye|bye for now|bye ada|goodbye ada|thanks bye|thank you bye|ok bye|okay bye|end (the )?call|hang up|that's it for (now|today) bye)$/;
export const REPEAT = /^(repeat|repeat that|say that again)$/;
export const AUDIO = /^switch to audio( only)?( mode)?$/;
export const VISUAL = /^switch to (visual|video|screen)( mode)?$/;
export const SHORTER = /^shorter$/;
const STATUS = /^(status|status report|roll call|everyone|where are we|what'?s? (the )?status|how is everyone|sitrep)$/;
const STOP_ALL = /^(stop everyone|stop everything|everyone stop|stop all)$/;
export const STANDUP = /^(stand ?up|stand-up|team (update|updates|meeting)|everyone report|round the table|go round the table|daily stand ?up)$/;
export const UPDATES = /^(updates?|any updates|what did i miss|what'?s new|notifications?|read (me )?(the )?(updates|notifications)|tell me now|what'?s waiting|who'?s waiting|who is waiting|what is waiting|bring (them|it|those) up|go through (them|the queue)|what do they need|who needs me|anyone waiting|is anyone waiting)$/;
// the whole of something that was summed up short: the news just read, or the agent's last answer
export const MORE = /^(tell me more|more|more detail|more details|go on with that|in full|in detail|the whole thing|all of it|say all of it|read (it|me) all|read (it|me) everything|(the |give me the |i want the )?full (version|report|summary|details|story)|give me (a |the )?full summary|full summary please|what else did (he|she|it|they) say|tell me everything|walk me through it)$/;
export const NEXT = /^(next|who'?s next|next please|next person|what'?s next|take me to the next|go to the next)$/;
export const HOLD = /^(hold (my|all|the) calls|do not disturb|don'?t disturb me|no interruptions|focus mode|quiet please|hold everything)$/;
export const UNHOLD = /^(i'?m free|i am free|take calls|resume calls|you can interrupt( me)?|calls back on|i'?m back|interrupt me again)$/;

/** Patterns handled entirely on the page. Matched before the echo guard, so they never vanish. */
export const LOCAL = [PAUSE, RESUME, STOP, SLEEP, REPEAT, AUDIO, VISUAL, SHORTER, STATUS, STOP_ALL, UPDATES, STANDUP, NEXT, HOLD, UNHOLD, MORE];

const LOCAL_KINDS = [
  [PAUSE, "pause"], [RESUME, "resume"], [STOP, "stop"], [SLEEP, "sleep"],
  [REPEAT, "repeat"], [AUDIO, "audio"], [VISUAL, "visual"], [SHORTER, "shorter"],
  [STATUS, "status"], [STOP_ALL, "stop-all"], [UPDATES, "updates"], [STANDUP, "standup"], [NEXT, "next"], [MORE, "more"], [HOLD, "hold"], [UNHOLD, "unhold"],
];

const TAKE = /\b(?:take me (?:over )?to|put me (?:through|over) to|switch me (?:over )?to|connect me (?:to|with)|let me (?:talk|speak) (?:to|with)|i (?:want|need|would like|'?d like) to (?:talk|speak) (?:to|with)|can i (?:talk|speak) (?:to|with)|go back to|back over to|over to) (\w+)\b/;
const GREETING = /^(?:(?:hi|hey|hello|okay|ok|so|um|uh|oh|yo|and|sorry|excuse me|right)\s+)+/;
const GREETING_RAW = /^\W*(?:(?:hi|hey|hello|okay|ok|so|um|uh|oh|yo|and|sorry|excuse me|right)\b[\s,.!]*)+/i;

/** One edit apart, for a bare name said on its own where a wrong guess costs nothing. */
function near(a, b) {
  if (a === b) return true;
  if (Math.abs(a.length - b.length) > 1 || Math.max(a.length, b.length) < 4) return false;
  let i = 0, j = 0, slips = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) { i++; j++; continue; }
    if (++slips > 1) return false;
    if (a.length > b.length) i++;
    else if (a.length < b.length) j++;
    else { i++; j++; }
  }
  return slips + (a.length - i) + (b.length - j) <= 1;
}

const findExact = (projects, word) => projects.find((p) => norm(p.name) === word) ?? null;
/** A loose match is only trusted when exactly one project answers to it. */
function findNear(projects, word) {
  const hits = projects.filter((p) => near(norm(p.name), word));
  return hits.length === 1 ? hits[0] : null;
}

/**
 * What to do with something the person said.
 *
 * - `local`    a page command, with `name` saying which
 * - `focus`    put a project on the line and say nothing else
 * - `address`  a project by name plus a question for it
 * - `grant` / `deny` / `park`  acting on a named project, or the one that is waiting
 * - `tell`     pass a message to a named project without moving the line ("tell Rex to use SQLite")
 * - `ask`      send to whoever is on the line
 */
export function route(raw, projects, { waiting = null } = {}) {
  const t = norm(raw);
  if (!t) return { kind: "ask", text: "" };

  for (const [re, name] of LOCAL_KINDS) if (re.test(t)) return { kind: "local", name };

  const words = t.split(" ");

  // "can you take me to Juno", "let me talk to Rex", "hi Ada, take me to Juno": moving the line is
  // something the page can do at once, wherever in the sentence it is asked for and whoever is
  // being spoken to. Only a real name counts, so "get me the logs" is left alone.
  const take = TAKE.exec(t);
  if (take) {
    const target = findExact(projects, take[take.length - 1]) ?? findNear(projects, take[take.length - 1]);
    if (target) return { kind: "focus", project: target.id };
  }

  // "hi Ada, what's Rex doing?", "okay Juno, run the tests": a greeting then a name is someone
  // being addressed, and it wins over whoever has the line. A greeting makes the name a strong
  // signal, so a near miss from the recognizer ("hey Aida") is forgiven here.
  const greeted = t.replace(GREETING, "");
  if (greeted !== t && greeted) {
    const first = greeted.split(" ")[0];
    const target = findExact(projects, first) ?? findNear(projects, first);
    if (target) {
      const rest = raw.trim().replace(GREETING_RAW, "").replace(/^[^\s,.:!?]+[\s,.:!?]*/, "").trim();
      return rest ? { kind: "address", project: target.id, text: rest } : { kind: "focus", project: target.id };
    }
  }

  // "allow ada" / "allow it" / "allow ada always" — never "go ahead", which resumes the voice
  const permit = /^(allow|grant|approve|permit|let)( it| that| them)?$/.exec(words.slice(0, 2).join(" ")) || /^(allow|grant|approve|permit|let)$/.exec(words[0] ?? "");
  if (permit) {
    const rest = t.slice(permit[0].length).trim().split(" ").filter(Boolean);
    const named = rest.length ? findExact(projects, rest[0]) : null;
    const scope = /\b(always|from now on|every time)\b/.test(t) ? "always" : "once";
    const target = named ?? (waiting ? projects.find((p) => p.id === waiting) : null);
    if (target) return { kind: "grant", project: target.id, scope };
  }
  if (/^(deny|refuse|reject|don't allow|do not allow)\b/.test(t) || /^no don'?t\b/.test(t)) {
    const rest = words.slice(1);
    const named = rest.length ? findExact(projects, rest[0]) : null;
    const target = named ?? (waiting ? projects.find((p) => p.id === waiting) : null);
    if (target) return { kind: "deny", project: target.id };
  }

  const park = /^(park|pause|shelve|put away|let go of) (\w+)$/.exec(t);
  if (park) {
    const target = findExact(projects, park[2]);
    if (target) return { kind: "park", project: target.id };
  }

  // "tell rex to use sqlite" / "tell rex: sqlite" — the answer to a relayed question, sent without
  // leaving whoever you are talking to. Exact names only: this carries an instruction.
  const tell = /^(tell|ask|answer|reply to) (\w+)\b/.exec(t);
  if (tell) {
    const target = findExact(projects, tell[2]);
    if (target && !target.central) {
      const rest = raw.trim().replace(/^\S+\s+(to\s+)?\S+?[\s,:]+/i, "").replace(/^(to|that)\s+/i, "").trim();
      if (rest) return { kind: "tell", project: target.id, text: rest };
    }
  }

  // "switch to ada" / "talk to ada" / "put ada on"
  const switchTo = /^(switch to|talk to|go to|go back to|back to|bring up|put on|put|put me through to|give the floor to|over to)\s+(\w+)(\s+on)?$/.exec(t);
  if (switchTo) {
    const target = findExact(projects, switchTo[2]) ?? findNear(projects, switchTo[2]);
    if (target) return { kind: "focus", project: target.id };
  }

  // the whole line is just a name: a loose match is fine, nothing is lost by guessing wrong
  if (words.length === 1) {
    const target = findExact(projects, words[0]) ?? findNear(projects, words[0]);
    if (target) return { kind: "focus", project: target.id };
  }

  // "ada, run the tests" — only an exact name redirects an instruction
  const named = findExact(projects, words[0]);
  if (named && words.length > 1) {
    const rest = raw.trim().replace(/^[^\s,]+\s*,?\s*/, "");
    return { kind: "address", project: named.id, text: rest || "" };
  }

  return { kind: "ask", text: raw.trim() };
}

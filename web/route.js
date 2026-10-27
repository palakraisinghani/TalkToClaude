import { usableAlias } from "./words.js";
import { controlOf } from "./controls.js";
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
// back to the agent you left to talk to the assistant
export const BACK = /^(?:(?:ok|okay|right|alright|thanks|thank you|great)\s+)*(?:(?:go|take me|put me|let'?s go|send me|switch|get me) )?back(?: (?:to (?:it|him|her|them|where i was|what i was doing|work)|again|please|now))?$|^return(?: to (?:it|him|her|them|where i was))?$/;
// finished with whoever has the line: the floor goes back to the assistant
export const DONE = /^(?:(?:ok|okay|right|alright|great|cool|thanks|thank you|perfect)\s+)*(?:(?:i'?m|i am|we'?re|we are|all) done(?: (?:here|for now|now|with (?:you|this|that|him|her|them|\w+)))?|(?:that'?s|that is) (?:all|it|everything)(?: for now)?|(?:that'?ll|that will) do|nothing else|no more)(?:\s+(?:thanks|thank you|thanks a lot|for now))*$/;
export const UNHOLD = /^(i'?m free|i am free|take calls|resume calls|you can interrupt( me)?|calls back on|i'?m back|interrupt me again)$/;

/** Patterns handled entirely on the page. Matched before the echo guard, so they never vanish. */
/** "learn my voice", "teach names": start teaching how the lead says the names, hands-free. */
export const TEACH = /^(?:(?:can you |please |let'?s )?(?:learn|teach(?: you)?|train(?: on)?) (?:my voice|(?:the |our |everyone'?s |all (?:the )?)?names?|how i say (?:the |their )?names?|how i say \w+|\w+'?s name|the name \w+)(?: please| again)?|voice training|name training|(?:teach|learn|train) (?:ada|\w+) again)$/;
export const LOCAL = [PAUSE, RESUME, STOP, SLEEP, REPEAT, AUDIO, VISUAL, SHORTER, STATUS, STOP_ALL, UPDATES, STANDUP, NEXT, HOLD, UNHOLD, MORE, DONE, BACK, TEACH];

const LOCAL_KINDS = [
  [PAUSE, "pause"], [RESUME, "resume"], [STOP, "stop"], [SLEEP, "sleep"],
  [REPEAT, "repeat"], [AUDIO, "audio"], [VISUAL, "visual"], [SHORTER, "shorter"],
  [STATUS, "status"], [STOP_ALL, "stop-all"], [UPDATES, "updates"], [STANDUP, "standup"], [NEXT, "next"], [MORE, "more"], [HOLD, "hold"], [UNHOLD, "unhold"], [DONE, "done"], [BACK, "back"], [TEACH, "teach"],
];

/** What joins a request for the agent you are being put through to: "…and ask her to run the tests". */
const JOINED = /^(?:(?:and|so|then) )?(?:(?:ask|tell) (?:her|him|them|it) (?:to |that )?|have (?:her|him|them) |let (?:her|him|them) know (?:that )?)|^(?:and|so|then) /;
/** Nothing of substance: greetings, names, "can you", "please". */
function isFiller(words, projects) {
  const names = new Set(projects.flatMap((p) => [norm(p.name), ...(p.aliases ?? []).map(norm)]));
  return words.split(" ").every((w) => !w || names.has(w) || /^(?:hi|hey|hello|okay|ok|so|now|just|please|thanks|thank|you|can|could|would|will|kindly|go|ahead|right|alright|yeah|yes)$/.test(w));
}

/** Words before a name that make it part of the sentence, not someone being called. */
const NOT_CALLED = /^(to|with|for|from|about|and|or|ask|tell|than|like|of|at|by|call|named|called|is|was)$/;
const TAKE = /\b(?:take me (?:over )?to|put me (?:through|over) to|switch me (?:over )?to|connect me (?:to|with)|let me (?:talk|speak) (?:to|with)|i (?:want|need|would like|'?d like) to (?:talk|speak) (?:to|with)|can i (?:talk|speak) (?:to|with)|go back to|back over to|over to) (\w+)\b/;
const GREETING = /^(?:(?:hi|hey|hello|okay|ok|okey|okie|so|um|uh|oh|yo|and|sorry|excuse me|right)\s+)+/;
const GREETING_RAW = /^\W*(?:(?:hi|hey|hello|okay|ok|okey|okie|so|um|uh|oh|yo|and|sorry|excuse me|right)\b[\s,.!-]*)+/i;

/** One edit apart, for a bare name said on its own where a wrong guess costs nothing. */
export function near(a, b) {
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

/**
 * Roughly how a name sounds, so the recognizer's guesses at it still match: "Aida", "Ida", "Etta"
 * and "Ader" all come out like "Ada"; "Mylo" and "Myla" like "Milo"; "Wrecks" like "Rex". Vowels
 * blur into one, t and d are one sound, so are c, k and q, a silent letter goes, so does an r
 * after a vowel the way most accents say it ("Order" for "Aada"), and doubled letters count once.
 */
export function sound(word) {
  return word.toLowerCase().replace(/'s$/, "").replace(/[^a-z]/g, "")
    .replace(/^wr/, "r").replace(/^kn/, "n").replace(/ph/g, "f").replace(/c(?=[eiy])/g, "s")
    .replace(/ck|c|q/g, "k").replace(/x/g, "ks").replace(/z/g, "s")
    .replace(/h/g, "").replace(/([aeiouy])r(?=$|[^aeiouy])/g, "$1").replace(/t/g, "d")
    .replace(/([^aeiouy])\1+/g, "$1").replace(/[aeiouy]+/g, "a");
}

/**
 * Does any word here sound like this name, once blurred to its consonants? "Juneau" for Juno,
 * "Mylo" for Milo, "Aida" for Ada. Used to back up a voice match that is not quite sure on its
 * own: an ordinary word the recognizer got right ("hello", "okay") does not qualify.
 */
export function soundsLike(text, name, { accent = "" } = {}) {
  const indian = /india/i.test(accent);
  const shape = (w) => sound(indian ? indianSounds(w) : w);
  const target = shape(norm(name));
  if (!target) return false;
  const vowelStart = /^[aeiou]/.test(norm(name));
  return norm(text).split(" ").some((w) => {
    if (w.length < 2 || GREETING_WORDS.has(w)) return false;
    const forms = [w];
    // an Indian-English "Ada" is often heard with a sound in front of it: "Bada", "Pada", "Hada"
    if (indian && vowelStart && /^[bcdfghjklmnpqrstvwxyz][aeiou]/.test(w)) forms.push(w.slice(1));
    return forms.some((f) => {
      const s = shape(f);
      return s === target || (opening(f) === opening(norm(name)) && lev(s, target) <= 1 && Math.min(s.length, target.length) >= 2);
    });
  });
}

/**
 * Sounds an Indian-English speaker and an English-trained recognizer often trade: v and w, z and j,
 * a "th" said as t or d (already the same once blurred), and a doubled vowel. Applied to both
 * sides, so "Vren" and "Wren", "Jero" and "Zero", meet.
 */
function indianSounds(w) {
  return w.replace(/v/g, "w").replace(/z/g, "j").replace(/aa/g, "a").replace(/ee/g, "i").replace(/oo/g, "u");
}
/**
 * A line with its opening name taken off: "hey Juneau, run the tests" → "run the tests". For when
 * the voice knew the name the recognizer misspelled; empty if nothing would be left.
 */
export function afterName(raw) {
  const rest = String(raw ?? "").trim().replace(GREETING_RAW, "").replace(/^[^\s,.:!?]+[\s,.:!?]*/, "").trim();
  return rest.split(/\s+/).filter(Boolean).length ? rest : "";
}
const GREETING_WORDS = new Set(["hi", "hey", "hello", "okay", "ok", "so", "um", "uh", "oh", "yo", "and", "sorry", "right", "the", "a", "to", "please", "thanks", "thank", "you"]);

/** Every way an agent can be called: its name, and any other spellings it was given. */
const callNames = (p) => [p.name, ...(p.aliases ?? [])];

/** Plain edit distance, for telling apart two names that sound alike once blurred. */
export function lev(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    prev = cur;
  }
  return prev[b.length];
}
/** How a word opens: "o" for o, au, aw; "a" for any other vowel; otherwise its first letter. */
const opening = (w) => (/^(o|au|aw)/.test(w) ? "o" : /^[aeiuy]/.test(w) ? "a" : w[0]);

/**
 * An agent by a near-sounding name. Only trusted where a wrong guess just moves the line: a name
 * on its own, after a greeting, or after "switch to".
 *
 * Blurred this far, some names collide: "Ada" and "Otto" both come out as "ada". A tie goes to
 * the other agent only when the word plainly starts like its name and is spelled close to it
 * ("otter", "auto" for Otto); otherwise to the assistant, who is the way to everyone else, so
 * reaching her by mistake costs a sentence while missing her leaves you stuck.
 *
 * The assistant is also found under a consonant or two the recognizer ran onto the front of her
 * name: "hey Gator" for "hey Ada", and after "switch to" / "back to", where "to Ada" is often
 * heard as "radar", "later" or "waiter" (`loose`).
 */
function findSound(projects, word, { loose = false } = {}) {
  if (!word || findExact(projects, word)) return null;
  const s = sound(word);
  if (s.length < 2) return null;
  let hits = projects.filter((p) => callNames(p).some((n) => sound(n) === s));
  const c = projects.find((p) => p.central);
  if (!hits.length && c) {
    // a d heard as n ("Anna", "Kana" for "Aada") is forgiven for her alone
    const her = sound(c.name), mine = s.replace(/n/g, "d");
    const lead = loose ? /^[^a]{1,2}(?=a)/ : /^[ghknm](?=a)/;
    if (mine === her || (lead.test(mine) && mine.replace(lead, "") === her)) hits = [c];
  }
  if (hits.length > 1) {
    const close = hits.filter((p) => !p.central && callNames(p).some((n) => opening(norm(n)) === opening(word) && lev(norm(n), word) <= 2));
    hits = close.length === 1 ? close : hits.some((p) => p.central) ? [c] : hits;
  }
  return hits.length === 1 ? hits[0] : null;
}

/**
 * A line that is only a name, in the forms the recognizer actually gives for one short word:
 * itself ("ada"), said twice ("ada ada", "gator gator"), or broken into short pieces that sound
 * like it run together ("a to", "add a", "ah da", "a d a").
 */
function nameForms(bare) {
  const w = bare.split(" ").filter(Boolean);
  if (w.length === 1) return w;
  const forms = [];
  if (w.length % 2 === 0 && w.slice(0, w.length / 2).join(" ") === w.slice(w.length / 2).join(" ")) forms.push(...nameForms(w.slice(0, w.length / 2).join(" ")));
  if (w.length <= 3 && w.every((x) => x.length <= 4)) forms.push(w.join(""));
  return forms;
}
function findBare(projects, bare) {
  for (const f of nameForms(bare)) {
    const target = findExact(projects, f) ?? findNear(projects, f) ?? findSound(projects, f);
    if (target) return target;
  }
  return null;
}

/** "Ada?", "Ada please", "hey Ada are you there": what is left once courtesy is taken off a name. */
const COURTESY_TAIL = /\s+(?:please|are you there|you there|can you hear me|i'?m done|i am done|i'?m back|come in|over here)$/;
export const bareName = (t) => t.replace(GREETING, "").replace(COURTESY_TAIL, "").trim();

/**
 * A name as the recognizer wrote it when someone said only that name: one word, with greetings,
 * courtesy, repeats and split pieces folded ("Felix, Felix." -> "felix", "a to" -> "ato"). "" when
 * the line was more than a name.
 */
export function spokenName(t) {
  const bare = bareName(norm(t));
  if (!bare) return "";
  // an everyday word ("do" for Juno) is never kept as a name: it would capture ordinary speech
  const forms = nameForms(bare).filter(usableAlias);
  return forms[0] ?? "";
}

/** The agent a whole line calls by name, however the recognizer spelled it; or null. */
export function calledBy(t, projects) {
  const bare = bareName(norm(t));
  return bare ? findBare(projects, bare) : null;
}

// an alias given in the roster is as good as the name: it was chosen, not guessed
const findExact = (projects, word) =>
  projects.find((p) => norm(p.name) === word) ?? projects.find((p) => (p.aliases ?? []).some((a) => norm(a) === word)) ?? null;
/** A loose match is only trusted when exactly one project answers to it. */
function findNear(projects, word) {
  const hits = projects.filter((p) => callNames(p).some((n) => near(norm(n), word)));
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
 * - `handoff`  be put through to someone with a note ("connect me to Ada and ask her to …")
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
    const target = findExact(projects, take[take.length - 1]) ?? findNear(projects, take[take.length - 1]) ?? findSound(projects, take[take.length - 1], { loose: true });
    const before = t.slice(0, take.index).trim();
    const after = t.slice(take.index + take[0].length).trim();
    // "…connect me to Ada and ask her to switch me to Juno": what is joined on as a request for
    // them goes with you, as a note
    const forThem = JOINED.exec(after);
    // Anything else said with it is for whoever you are talking to now: "Hand over to Milo. I think
    // you are stupid." is said to Ada, not passed to Milo. Then it all goes to them, and they reply
    // and hand you over themselves (Ada's <switch>, an agent's <handoff>).
    const other = (before && !isFiller(before, projects)) || (after && !forThem && !isFiller(after, projects));
    if (target && other) return { kind: "ask", text: raw.trim() };
    if (target && forThem) {
      const note = after.slice(forThem[0].length).trim();
      if (note.split(" ").length >= 2) return { kind: "handoff", project: target.id, text: note };
    }
    if (target) return { kind: "focus", project: target.id };
  }

  // "hi Ada, what's Rex doing?", "okay Juno, run the tests": a greeting then a name is someone
  // being addressed, and it wins over whoever has the line. A greeting makes the name a strong
  // signal, so a near miss from the recognizer ("hey Aida") is forgiven here.
  const greeted = t.replace(GREETING, "");
  if (greeted !== t && greeted) {
    const first = greeted.split(" ")[0];
    const target = findExact(projects, first) ?? findNear(projects, first) ?? findSound(projects, first);
    if (target) {
      const rest = raw.trim().replace(GREETING_RAW, "").replace(/^[^\s,.:!?]+[\s,.:!?]*/, "").trim();
      return rest ? { kind: "address", project: target.id, text: rest } : { kind: "focus", project: target.id };
    }
  }

  // "teach Ada", "learn Juno": teaching that name — only when the word is a name on the call, so
  // "learn python", said to an agent, still goes to the agent
  const teachOne = /^(?:teach|learn|train) (\w+)(?:'s)?(?: name)?(?: again)?$/.exec(t);
  if (teachOne && findExact(projects, teachOne[1])) return { kind: "local", name: "teach" };

  // "stop Juno": cut one agent's work off, wherever the line is
  const stopOne = /^(?:please )?stop (\w+)(?: (?:now|working|that|please))?$/.exec(t);
  if (stopOne) {
    const target = findExact(projects, stopOne[1]) ?? findNear(projects, stopOne[1]);
    if (target && !target.central) return { kind: "stop-agent", project: target.id };
  }

  // "undo what Juno did", "undo Juno's last change", "Ada, undo that": roll an agent's last turn back.
  // With no name it is whoever has the line.
  if (/\b(undo|roll back|rollback|revert)\b/.test(t) && words.length <= 9) {
    const named = projects.find((p) => !p.central && words.some((w) => w.replace(/'s$/, "") === norm(p.name)));
    return { kind: "undo", project: named?.id ?? null };
  }

  // Claude Code's controls for whoever has the floor: "plan mode", "think harder", "new
  // conversation", "compact" — the whole utterance only (controls.js)
  const control = controlOf(t);
  if (control) return { kind: "control", ...control };

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
  const switchTo = /^(switch(?:ed)? (?:back )?(?:to|through|over to)|switch(?:ed)?|which|talk to|go to|go back to|back to|bring up|put on|put|put me through to|give the floor to|over to)\s+(\w+)(\s+on)?$/.exec(t);
  if (switchTo) {
    const target = findExact(projects, switchTo[2]) ?? findNear(projects, switchTo[2]) ?? findSound(projects, switchTo[2], { loose: true });
    if (target) return { kind: "focus", project: target.id };
  }

  // the whole line is just a name, perhaps with a please: a loose match is fine, nothing is lost
  // by guessing wrong
  const bare = bareName(t);
  if (bare) {
    const target = findBare(projects, bare);
    if (target) return { kind: "focus", project: target.id };
  }

  // "can you run the tests, Juno?" — a name closing the sentence after a comma is said to them.
  // Not "send it to Juno" or "tell Ada about it": there the name is part of the sentence. Exact
  // names only, and never a name in the middle of what was said.
  if (words.length >= 3 && /,\s*[^\s,.!?]+[.!?]*\s*$/.test(raw.trim()) && !NOT_CALLED.test(words[words.length - 2])) {
    const target = findExact(projects, words[words.length - 1]);
    if (target) return { kind: "address", project: target.id, text: raw.trim().replace(/,\s*[^\s,.!?]+([.!?]*)\s*$/, "$1").trim() };
  }

  // "ada, run the tests" — only an exact name redirects an instruction
  const named = findExact(projects, words[0]);
  if (named && words.length > 1) {
    const rest = raw.trim().replace(/^[^\s,]+\s*,?\s*/, "");
    return { kind: "address", project: named.id, text: rest || "" };
  }

  return { kind: "ask", text: raw.trim() };
}

/**
 * Would this name be confused with one already on the call? Names are said out loud and matched
 * from speech, so two that blur together ("Otto" and "Ada": both "ada" once vowels and t/d are
 * blurred) make one of them hard to reach. Returns the name it clashes with, or null.
 */
export function confusable(name, others) {
  const a = norm(name);
  for (const other of others) {
    const b = norm(other);
    if (!a || !b || a === b) continue;
    const sa = sound(a), sb = sound(b);
    if (sa === sb || near(a, b) || (Math.max(a.length, b.length) <= 4 && lev(a, b) <= 1)) return other;
    // the assistant also answers to a d heard as n, so keep clear of that too
    if (sa.replace(/n/g, "d") === sb.replace(/n/g, "d")) return other;
  }
  return null;
}

// The call's single mouth: a sentence queue on top of speechSynthesis that can stop mid-word,
// resume from the same word, and report exactly what the listener did and did not hear.
//
// Several speakers share it — the central voice and whichever project is on the line — because
// there is only one speechSynthesis and only one pair of ears. Each sentence carries the identity
// it should be said in, the queue hands out the floor one sentence at a time, and a change of
// speaker is announced with that speaker's earcon.

import { isEchoOf } from "./echo.js";

// How long Buddy's own words can still come back through the speakers, and how many
// utterances back to keep. Old speech cannot echo, so the guard forgets it.
const ECHO_MEMORY_MS = 8000;
const ECHO_MEMORY_ITEMS = 4;

export class Voice {
  constructor({ onWord, onSentence, onIdle, onSpeaker, earcons } = {}) {
    this.onWord = onWord ?? (() => {});
    this.onSentence = onSentence ?? (() => {});
    this.onIdle = onIdle ?? (() => {});
    this.onSpeaker = onSpeaker ?? (() => {});
    this.earcons = earcons ?? null;
    this.speaker = null; // identity of whoever last had the floor
    this.queue = []; // { text, turn, record }
    this.current = null; // { text, turn, record, start, at, u }
    this.held = false;
    this.pending = false; // an earcon is playing; speech follows it
    this.gen = 0; // bumped by clear(); an earcon from an older generation never gets to speak
    this.pendingItem = null;
    this.heard = []; // sentences fully heard in the current turn
    this.lastTurnSpoken = [];
    this.uttered = []; // { text, at } actually spoken out loud, newest last, for the echo guard
    this.voices = [];
    const load = () => (this.voices = speechSynthesis.getVoices() ?? []);
    speechSynthesis.onvoiceschanged = load;
    load();
  }

  /**
   * The first of an identity's candidate voices this browser actually has. Voices load late, so
   * this is resolved at speaking time rather than once at startup.
   */
  #resolve(identity) {
    if (!this.voices.length) this.voices = speechSynthesis.getVoices() ?? [];
    const wanted = identity?.voices ?? [];
    for (const name of wanted) {
      const hit = this.voices.find((v) => v.name === name) ?? this.voices.find((v) => v.name.includes(name));
      if (hit) return hit;
    }
    return this.voices.find((v) => /Natural/.test(v.name) && v.lang.startsWith("en"))
      ?? this.voices.find((v) => v.lang?.startsWith("en"))
      ?? null;
  }

  /** Which voices from the roster this browser can actually produce, for a startup warning. */
  missing(identities) {
    return identities.filter((i) => !(i.voices ?? []).some((n) => this.voices.some((v) => v.name === n || v.name.includes(n))));
  }

  /**
   * Safari only lets speech start inside a click. Speaking nothing, synchronously in the call
   * button's handler, unlocks it for the rest of the page's life, so speech that starts later —
   * after an earcon, or when news arrives — is still allowed.
   */
  unlock() {
    try { speechSynthesis.speak(new SpeechSynthesisUtterance("")); } catch {}
  }

  get busy() { return !!this.current || this.queue.length > 0; }
  get speaking() { return !!this.current; }

  /**
   * Queue a sentence in a given voice. record=false for fillers and narration that should not be
   * replayed or reported. front=true puts it next in line, after the sentence being spoken: this
   * is how the central voice reads out an update without ever cutting anyone off mid-sentence.
   */
  say(text, turn, { record = true, identity = null, front = false, speaker = null } = {}) {
    if (!record && !front && (this.busy || this.held)) return; // fillers never pile up
    const item = { text, turn, record, identity, speaker };
    if (front) {
      const at = this.queue.findIndex((q) => !q.front);
      this.queue.splice(at < 0 ? this.queue.length : at, 0, { ...item, front: true });
    } else this.queue.push(item);
    this.#next();
  }

  /** Stop instantly but remember the position, so resume() picks up at the same word. */
  hold() {
    this.held = true;
    const c = this.current;
    if (!c) return;
    this.current = null;
    this.#endUtterance(c, false);
    if (c.record) {
      const from = c.start + wordStart(c.text.slice(c.start), c.at);
      this.queue.unshift({ ...c, start: from });
    }
    this.queue = this.queue.filter((q) => q.record);
    speechSynthesis.cancel();
  }

  resume() {
    this.held = false;
    this.#next();
  }

  /** Drop everything: a new turn is starting. */
  clear() {
    this.held = false;
    this.gen++;
    this.queue = [];
    if (this.current) this.#endUtterance(this.current, false);
    this.current = null;
    speechSynthesis.cancel();
  }

  /** Nothing queued, nothing speaking, no earcon in flight. */
  get idle() {
    return !this.busy && !this.pending;
  }

  /** Drop everything a given speaker had queued, leaving the others alone. */
  clearSpeaker(speaker) {
    // only invalidate an earcon in flight if it belongs to the speaker being cleared
    if (this.pendingItem?.speaker === speaker) this.gen++;
    this.queue = this.queue.filter((q) => q.speaker !== speaker);
    if (this.current?.speaker === speaker) {
      this.#endUtterance(this.current, false);
      this.current = null;
      speechSynthesis.cancel();
      this.#next();
    }
  }

  newTurn() {
    if (this.heard.length) this.lastTurnSpoken = this.heard;
    this.heard = [];
    // what was already said out loud is deliberately kept: it can still be echoing back
  }

  /** What the listener heard last and what they have not heard yet. */
  snapshot() {
    const pending = this.queue.filter((q) => q.record);
    const partial = pending[0] && pending[0].start > 0 ? pending[0].text.slice(0, pending[0].start).trim() : "";
    const heard = partial || this.heard[this.heard.length - 1] || "";
    const unheard = pending.map((q) => q.text.slice(q.start ?? 0).trim());
    return { heard, unheard };
  }

  /** Does this transcript look like Buddy's own voice, picked up from the speakers? */
  isEcho(text) {
    const cutoff = Date.now() - ECHO_MEMORY_MS;
    while (this.uttered.length && (this.uttered[0].at < cutoff || this.uttered.length > ECHO_MEMORY_ITEMS)) this.uttered.shift();
    return isEchoOf(text, this.uttered.map((u) => u.text).join(" "));
  }

  #next() {
    if (this.held || this.current || this.pending) return;
    const item = this.queue.shift();
    if (!item) { this.onIdle(); return; }
    // a change of speaker gets its earcon first, so you know who is talking before they talk
    if (this.earcons && item.identity && item.speaker !== this.speaker) {
      this.pending = true;
      this.pendingItem = item;
      this.speaker = item.speaker;
      this.onSpeaker(item.speaker, item.identity);
      const gen = this.gen;
      this.earcons.play(item.identity).finally(() => {
        this.pending = false;
        this.pendingItem = null;
        if (gen !== this.gen) return this.#next(); // cleared while the earcon played
        this.#speak(item);
      });
      return;
    }
    this.speaker = item.speaker;
    this.#speak(item);
  }

  #speak(item) {
    if (this.held) { this.queue.unshift(item); return; }
    const start = item.start ?? 0;
    const c = { ...item, start, at: 0 };
    const u = new SpeechSynthesisUtterance(item.text.slice(start));
    const v = this.#resolve(item.identity);
    if (v) u.voice = v;
    u.pitch = item.identity?.pitch ?? 1;
    u.rate = item.identity?.rate ?? 1.05;
    c.u = u;
    // the guard only ever compares against words that left the speaker
    c.said = { text: "", at: Date.now() };
    this.uttered.push(c.said);
    this.current = c;
    u.onboundary = (e) => {
      if (this.current !== c || e.name !== "word") return;
      c.at = e.charIndex;
      c.said.text = c.text.slice(start, start + e.charIndex + (e.charLength || 0));
      this.onWord(c.text, start + e.charIndex, e.charLength || 0);
    };
    // A watchdog: browsers sometimes never report the end of an utterance (Chrome drops onend
    // now and then, and stalls on long ones). Left alone, the voice would stay "busy" forever,
    // nothing else would ever be said, and the call would seem to hang. Allow generously for the
    // length of the sentence, then move on.
    const rate = u.rate || 1;
    const budget = 4000 + (item.text.length - start) * 95 / rate;
    c.watchdog = setTimeout(() => {
      if (this.current !== c) return;
      console.warn("speech never reported its end; moving on", c.text.slice(0, 60));
      finish();
    }, budget);
    const finish = () => {
      clearTimeout(c.watchdog);
      if (this.current !== c) return; // cancelled by hold() or clear()
      this.#endUtterance(c, true);
      this.current = null;
      if (c.record) this.heard.push(c.text);
      this.#next();
    };
    u.onend = finish;
    u.onerror = finish;
    this.onSentence(c.text, start, c.record);
    // a synthesiser left paused (Chrome does this after a tab sleeps) would take the utterance and never start it
    if (speechSynthesis.paused) speechSynthesis.resume();
    speechSynthesis.speak(u);
  }

  /**
   * Settle what this utterance actually said. Spoken to the end: the whole slice. Cut off by
   * hold() or clear(): whatever the word boundaries reported, since the rest never left the
   * speaker and so cannot come back through the mic.
   */
  #endUtterance(c, complete) {
    if (!c.said) return;
    if (complete) c.said.text = c.text.slice(c.start);
    c.said.at = Date.now();
    // cut off before the first word boundary: nothing was heard, so it is not worth remembering
    if (!c.said.text.trim()) this.uttered = this.uttered.filter((x) => x !== c.said);
  }
}

// index of the start of the word containing position i
function wordStart(text, i) {
  let j = Math.min(i, text.length);
  while (j > 0 && /\S/.test(text[j - 1])) j--;
  return j;
}

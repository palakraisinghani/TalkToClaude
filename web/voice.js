// Buddy's mouth: a sentence queue on top of speechSynthesis that can stop mid-word,
// resume from the same word, and report exactly what the listener did and did not hear.

const words = (t) => t.toLowerCase().replace(/[^\w ]/g, " ").split(/\s+/).filter(Boolean);

export class Voice {
  constructor({ onWord, onSentence, onIdle } = {}) {
    this.onWord = onWord ?? (() => {});
    this.onSentence = onSentence ?? (() => {});
    this.onIdle = onIdle ?? (() => {});
    this.queue = []; // { text, turn, record }
    this.current = null; // { text, turn, record, start, at, u }
    this.held = false;
    this.heard = []; // sentences fully heard in the current turn
    this.lastTurnSpoken = [];
    this.recent = new Set(); // words spoken lately, for the echo guard
    this.voice = null;
    const pick = () => {
      const vs = speechSynthesis.getVoices();
      this.voice = vs.find((v) => /Samantha/.test(v.name)) || vs.find((v) => /Google UK English Female/.test(v.name))
        || vs.find((v) => /Natural/.test(v.name) && v.lang.startsWith("en")) || vs.find((v) => v.lang.startsWith("en")) || null;
    };
    speechSynthesis.onvoiceschanged = pick;
    pick();
  }

  get busy() { return !!this.current || this.queue.length > 0; }
  get speaking() { return !!this.current; }

  /** Queue a sentence. record=false for fillers and narration that should not be replayed or reported. */
  say(text, turn, { record = true } = {}) {
    if (!record && (this.busy || this.held)) return; // fillers never pile up
    this.queue.push({ text, turn, record });
    words(text).forEach((w) => this.recent.add(w));
    this.#next();
  }

  /** Stop instantly but remember the position, so resume() picks up at the same word. */
  hold() {
    this.held = true;
    const c = this.current;
    if (!c) return;
    this.current = null;
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
    this.queue = [];
    this.current = null;
    speechSynthesis.cancel();
  }

  newTurn() {
    if (this.heard.length) this.lastTurnSpoken = this.heard;
    this.heard = [];
    this.recent = new Set();
  }

  /** What the listener heard last and what they have not heard yet. */
  snapshot() {
    const pending = this.queue.filter((q) => q.record);
    const partial = pending[0] && pending[0].start > 0 ? pending[0].text.slice(0, pending[0].start).trim() : "";
    const heard = partial || this.heard[this.heard.length - 1] || "";
    const unheard = pending.map((q) => q.text.slice(q.start ?? 0).trim());
    return { heard, unheard };
  }

  isEcho(text) {
    const w = words(text);
    return w.length > 0 && w.filter((x) => this.recent.has(x)).length / w.length >= 0.7;
  }

  #next() {
    if (this.held || this.current) return;
    const item = this.queue.shift();
    if (!item) { this.onIdle(); return; }
    const start = item.start ?? 0;
    const c = { ...item, start, at: 0 };
    const u = new SpeechSynthesisUtterance(item.text.slice(start));
    if (this.voice) u.voice = this.voice;
    u.rate = 1.05;
    c.u = u;
    this.current = c;
    u.onboundary = (e) => {
      if (this.current !== c || e.name !== "word") return;
      c.at = e.charIndex;
      this.onWord(c.text, start + e.charIndex, e.charLength || 0);
    };
    const finish = () => {
      if (this.current !== c) return; // cancelled by hold() or clear()
      this.current = null;
      if (c.record) this.heard.push(c.text);
      this.#next();
    };
    u.onend = finish;
    u.onerror = finish;
    this.onSentence(c.text, start, c.record);
    speechSynthesis.speak(u);
  }
}

// index of the start of the word containing position i
function wordStart(text, i) {
  let j = Math.min(i, text.length);
  while (j > 0 && /\S/.test(text[j - 1])) j--;
  return j;
}

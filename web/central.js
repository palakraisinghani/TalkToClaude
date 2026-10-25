// The assistant's scripted lines.
//
// The assistant is a Claude session of her own, for anything that needs thought: setting up
// projects, handing out work, answering questions about how the team stands. But much of what
// she says is a fact the page already knows for certain — who has the floor, who is waiting, what
// was just allowed — and for those a model would be slower, dearer, and occasionally wrong. Those
// lines are written here and spoken at once, in the same voice and as the same speaker, so the
// two halves of her sound like one person.
//
// Every line here goes next in the queue, after the sentence being spoken, and is never dropped:
// these are answers and confirmations, and a confirmation that goes missing is worse than none.

const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const STATE_WORDS = {
  working: "is working",
  blocked: "is waiting on you",
  warm: "is free",
  cold: "has not started yet",
  parked: "is parked",
};

export class Central {
  constructor({ voice, identity }) {
    this.voice = voice;
    this.identity = identity;
    this.speaker = "ada";
    this.name = "Ada";
  }

  setIdentity(identity, id, name) {
    if (identity) this.identity = identity;
    if (id) this.speaker = id;
    if (name) this.name = name;
  }

  say(text, { record = false } = {}) {
    if (!text) return;
    this.voice.say(text, 0, { record, identity: this.identity, speaker: this.speaker, front: true });
  }

  /** Said inside the click that starts the call, before the team is known. */
  hello() {
    this.say(`Hi, it's ${this.name}.`);
  }

  /** Said once the team arrives: who is here, and how to start. */
  greet(team) {
    const names = team.map((p) => p.name);
    if (!names.length) return this.say("No one on the team yet. Tell me what you want to build, and I'll set it up.");
    const waiting = team.filter((p) => p.waiting || p.question).map((p) => p.name);
    const lead = names.length === 1 ? `${names[0]} is on the team.` : `${list(names)} are on the team.`;
    const tail = waiting.length ? ` ${list(waiting)} ${waiting.length > 1 ? "are" : "is"} waiting on you.` : names.length === 1 ? ` Say ${names[0]} to talk to them.` : " Say a name to talk to one of them.";
    this.say(lead + tail);
  }

  /**
   * The handover when the floor moves: who you are now talking to, what they last did, and what
   * they are waiting on, in one breath. Back to the assistant herself is just a word.
   */
  handover(p, { heard = false } = {}) {
    if (!p || p.central) return this.say("Back with me.");
    const bits = [`${p.name}.`];
    if (p.state === "working") bits.push("Still working on it.");
    // a report the lead has just heard is not repeated; they came here to follow it up
    else if (p.report && !heard) bits.push(p.report.replace(/([^.!?])$/, "$1."));
    else if (p.state === "cold" && !p.report) bits.push("Ready when you are.");
    this.say(bits.join(" "));
  }

  status(team, focusedId) {
    team = team.filter((p) => !p.central);
    if (!team.length) return this.say("There's no one on the team yet.");
    const parts = team.map((p) => {
      const where = p.id === focusedId ? "has the floor" : p.waiting || p.question ? "is waiting on you" : STATE_WORDS[p.state] ?? "is free";
      return `${p.name} ${where}`;
    });
    this.say(`${parts.join(". ")}.`);
  }

  /** Stand-up: the assistant opens it; each agent then speaks for itself, in its own voice. */
  standupIntro(count) {
    this.say(count ? "Quick round of the table." : "There's no one on the team yet.");
  }

  standupEmpty(name) {
    return `${name}: nothing to report yet.`;
  }

  held() { this.say("Holding your calls. I'll just chime if someone needs you."); }
  unheld() { this.say("Okay, I'll let you know when someone's waiting."); }
  granted(name) { this.say(`Allowed. ${name} is carrying on.`); }
  denied(name) { this.say(`Denied. ${name} will do without it.`); }
  parked(name) { this.say(`${name} is parked. Say the name to pick it back up.`); }
  passedOn(name) { this.say(`Sent to ${name}.`); }
  nothingWaiting() { this.say("Nobody's waiting on you."); }
  stoppedAll(names) { this.say(names.length ? `Stopped ${list(names)}.` : "Nothing was running."); }
  cannot(text) { this.say(text); }
}

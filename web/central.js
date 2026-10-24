// The central voice's scripted lines.
//
// The central agent is a Claude session of her own, for anything that needs thought: making
// projects, handing out work, answering questions about how things stand. But a lot of what she
// says is a fact the page already knows for certain — who is on the line, who is waiting, what
// just finished — and for those a model would be slower, dearer, and occasionally wrong. Those
// lines are written here and spoken instantly, in the same voice and as the same speaker, so the
// two halves of her sound like one person.
//
// She owns the floor. Projects speak only while they are on the line; everything else they need
// to tell you arrives as a notification and comes out of her mouth.

const list = (items) => (items.length < 2 ? items.join("") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);

const STATE_WORDS = {
  working: "is working",
  blocked: "is waiting on you",
  warm: "is idle",
  cold: "has not started",
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

  /**
   * Say something in the central voice. These are confirmations and news, never filler, so they
   * are never dropped for being late: they go next, after the sentence in progress.
   */
  say(text, { now = true, record = false } = {}) {
    if (!text) return;
    this.voice.say(text, 0, { record, identity: this.identity, speaker: this.speaker, front: now });
  }

  /** Said inside the click that starts the call, before the roster is known. */
  hello() {
    this.say(`Hi, it's ${this.name}.`);
  }

  /** Said once the roster arrives: what is on it, and what to do next. */
  greet(projects) {
    const names = projects.map((p) => p.name);
    if (!names.length) return this.say("No projects yet. Tell me what you want to build, and I will set one up.");
    if (names.length === 1) return this.say(`${names[0]} is on the roster. Say ${names[0]} to talk to it, or tell me what we are working on.`);
    this.say(`${list(names)} are on the roster. Say a name to talk to one, or tell me what we are working on.`);
  }

  focused(project) {
    this.say(project.central ? `Back to me.` : `${project.name} is on the line.`);
  }

  passedOn(name) {
    this.say(`Passed on to ${name}.`);
  }

  nothingNew() {
    this.say("Nothing new.");
  }

  /** Roll call: one line per project, so parallel work can be taken in at once. */
  status(projects, focusedId) {
    projects = projects.filter((p) => !p.central);
    if (!projects.length) return this.say("There are no projects yet.");
    const parts = projects.map((p) => {
      const where = p.id === focusedId ? "is on the line" : STATE_WORDS[p.state] ?? "is idle";
      const waiting = p.waiting ? `, needing permission to use ${p.waiting}` : p.question ? ", with a question for you" : "";
      return `${p.name} ${where}${waiting}`;
    });
    this.say(`${parts.join(". ")}.`);
  }

  /** Read out what the projects you are not listening to have been trying to tell you. */
  relay(text) {
    this.say(text, { now: true });
  }

  granted(name) {
    this.say(`Granted. ${name} is carrying on.`);
  }

  denied(name) {
    this.say(`Left it. ${name} will not do that.`);
  }

  parked(name) {
    this.say(`${name} is parked. Say the name to pick it back up.`);
  }

  stoppedAll(names) {
    this.say(names.length ? `Stopped ${list(names)}.` : "Nothing was running.");
  }

  cannot(text) {
    this.say(text);
  }
}

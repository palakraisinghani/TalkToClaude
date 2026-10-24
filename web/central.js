// Buddy herself: the central voice.
//
// She is not another Claude session, and she costs nothing. Everything she says is written here,
// because every one of her jobs — who is on the line, who is waiting, what just finished — is
// something the page already knows for certain. A second model would be slower, dearer, and
// occasionally wrong about facts that are sitting in a variable.
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
    this.speaker = "buddy";
  }

  setIdentity(identity) {
    if (identity) this.identity = identity;
  }

  /** Say something as Buddy. `now` jumps the queue after the sentence in progress. */
  say(text, { now = false, record = false } = {}) {
    if (!text) return;
    this.voice.say(text, 0, { record, identity: this.identity, speaker: this.speaker, front: now });
  }

  greet(projects) {
    const names = projects.map((p) => p.name);
    if (!names.length) return this.say("I am here, but no projects are set up yet.");
    if (names.length === 1) return this.say(`Hey, I'm here with ${names[0]}. What are we working on?`);
    this.say(`Hey, I'm here. I have ${names.length} projects on the line: ${list(names)}. ${names[0]} is up first. Say a name to switch.`);
  }

  focused(project) {
    this.say(`${project.name}.`);
  }

  /** Roll call: one line per project, so parallel work can be taken in at once. */
  status(projects, focusedId) {
    if (!projects.length) return this.say("There are no projects.");
    const parts = projects.map((p) => {
      const where = p.id === focusedId ? "is on the line" : STATE_WORDS[p.state] ?? "is idle";
      const waiting = p.waiting ? `, needing permission to use ${p.waiting}` : "";
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

import { test } from "node:test";
import assert from "node:assert/strict";
import { ReplyParser, type ParsedEvent } from "./parser.ts";
import { clean } from "./cleaner.ts";
import { formatContext } from "./context.ts";

const run = (text: string, size = 3) => {
  const p = new ReplyParser();
  const ev: ParsedEvent[] = [];
  for (const ch of text.match(new RegExp(`[\\s\\S]{1,${size}}`, "g"))!) ev.push(...p.feed(ch));
  ev.push(...p.end());
  return ev;
};
const of = (ev: ParsedEvent[], kind: string) => ev.filter((e) => e.kind === kind).map((e) => e.text);

test("multiple say blocks stream sentences in order across chunk splits", () => {
  const ev = run("<say>Let me look.</say>\nReading auth.ts now\n<say>Found it. The fix is an await.\nWant more?</say>\n<screen>\nIn `a.ts`\n</screen>");
  assert.deepEqual(of(ev, "sentence"), ["Let me look.", "Found it.", "The fix is an await.", "Want more?"]);
  assert.equal(of(ev, "screen").join("").trim(), "In `a.ts`");
  assert.match(of(ev, "aside").join(""), /Reading auth\.ts now/);
  assert.equal(of(ev, "fallback").length, 0);
});

test("a say block without a closing period is still spoken when it closes", () => {
  assert.deepEqual(of(run("<say>Done, over to you</say>", 1), "sentence"), ["Done, over to you"]);
});

test("a stray < in working notes is not swallowed", () => {
  const ev = run("x < y and a<b\n<say>Ok.</say>", 2);
  assert.equal(of(ev, "aside").join(""), "x < y and a<b\n");
});

test("falls back when there is no say block", () => {
  const ev = run("Just plain text.");
  assert.deepEqual(of(ev, "fallback"), ["Just plain text."]);
});

test("action tags arrive whole, with attributes and body, and are never spoken", () => {
  const ev = run('<say>Setting it up.</say>\n<new name="Juno" folder="todo-app">Scaffold a todo app.</new>\n<switch to="rex"/>', 2);
  assert.deepEqual(of(ev, "sentence"), ["Setting it up."]);
  const actions = ev.filter((e) => e.kind === "action") as any[];
  assert.deepEqual(actions.map((a) => [a.name, a.attrs, a.body]), [
    ["new", { name: "Juno", folder: "todo-app" }, "Scaffold a todo app."],
    ["switch", { to: "rex" }, ""],
  ]);
  assert.doesNotMatch(of(ev, "aside").join(""), /<new|<switch/);
});

test("a question is spoken and also reported whole", () => {
  const ev = run("<question>Postgres or SQLite? I lean SQLite.</question>", 3);
  assert.deepEqual(of(ev, "sentence"), ["Postgres or SQLite?", "I lean SQLite."]);
  assert.deepEqual(of(ev, "question"), ["Postgres or SQLite? I lean SQLite."]);
  assert.equal(of(ev, "fallback").length, 0);
});

test("words that merely start like a tag stay in the notes", () => {
  const ev = run("a <newline> and <opening\n<say>Ok.</say>", 2);
  assert.equal(ev.filter((e) => e.kind === "action").length, 0);
  assert.match(of(ev, "aside").join(""), /<newline> and <opening/);
});

test("a full stop at the end of a streamed chunk does not split a word like plan.md", () => {
  const p = new ReplyParser();
  const ev = [...p.feed("<say>I wrote plan."), ...p.feed("md with five steps. Done"), ...p.feed("</say>"), ...p.end()];
  assert.deepEqual(of(ev, "sentence"), ["I wrote plan.md with five steps.", "Done"]);
});

test("cleaner", () => {
  assert.equal(clean("See `src/middleware/auth.ts` -> it can't use getUserById & more"), "See auth dot ts to it cannot use get User By Id and more");
  assert.equal(clean("Visit https://x.com now"), "Visit a link now");
  assert.match(clean("a\n```js\nx\n```\nb"), /code snippet on screen/);
});

test("call context", () => {
  assert.equal(formatContext("visual"), "[call · visual+audio · you are on the line]");
  // a project working in the background is told so, because its words are not spoken aloud
  assert.match(formatContext("visual", null, false), /you are in the background, your words are not spoken/);
  const s = formatContext("audio", { kind: "paused", pausedMs: 6200, heard: "The cache is stale because", unheard: ["It never expires.", "Want the fix?"], working: true });
  assert.equal(s, '[call · audio-only · you are on the line] [cut in: the user said pause 6s ago; the last thing they heard was "The cache is stale because"; they did not hear 2 more sentences: "It never expires. Want the fix?"; your previous work was stopped]');
  assert.match(formatContext("visual", { kind: "interrupted" }), /talked over you/);
});

test("any agent's handoff tag is passed on whole, with its note", () => {
  const p = new ReplyParser();
  const ev = [...p.feed('<say>Putting you through to Ada.</say><handoff to="Ada">wants to switch to Juno</handoff>'), ...p.end()];
  const h = ev.find((e) => e.kind === "action");
  assert.equal(h?.name, "handoff");
  assert.equal(h?.attrs.to, "Ada");
  assert.equal(h?.body.trim(), "wants to switch to Juno");
});

test("a project agent talking about a <close> button is just talking", () => {
  const p = new ReplyParser({ actions: ["handoff"] });
  const ev = [...p.feed("I'll wire up the <close> button handler. <say>Done, the button works.</say>"), ...p.end()];
  assert.deepEqual(of(ev, "sentence"), ["Done, the button works."]);
  assert.equal(ev.filter((e) => e.kind === "action").length, 0);
});

test("an action tag that never closes is let go as text instead of swallowing the turn", () => {
  const p = new ReplyParser();
  const ev = [...p.feed("Next I <open path=\"x\"> it. <say>All set.</say>"), ...p.end()];
  assert.deepEqual(of(ev, "sentence"), ["All set."]);
  assert.match(of(ev, "aside").join(""), /<open path="x">/);
});

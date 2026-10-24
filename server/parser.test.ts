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

test("cleaner", () => {
  assert.equal(clean("See `src/middleware/auth.ts` -> it can't use getUserById & more"), "See auth dot ts to it cannot use get User By Id and more");
  assert.equal(clean("Visit https://x.com now"), "Visit a link now");
  assert.match(clean("a\n```js\nx\n```\nb"), /code snippet on screen/);
});

test("call context", () => {
  assert.equal(formatContext("visual"), "[call · visual+audio]");
  const s = formatContext("audio", { kind: "paused", pausedMs: 6200, heard: "The cache is stale because", unheard: ["It never expires.", "Want the fix?"], working: true });
  assert.equal(s, '[call · audio-only] [cut in: the user said pause 6s ago; the last thing they heard was "The cache is stale because"; they did not hear 2 more sentences: "It never expires. Want the fix?"; your previous work was stopped]');
  assert.match(formatContext("visual", { kind: "interrupted" }), /talked over you/);
});

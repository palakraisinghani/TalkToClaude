import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "./transcript.ts";

async function recorded() {
  const tx = new Transcript(await mkdtemp(join(tmpdir(), "buddy-")));
  tx.open({ cwd: "/work" });
  tx.log({ type: "stt", state: "ready" });
  tx.log({ type: "turn", turn: 1, text: "why is login failing" });
  tx.log({ type: "transcript", id: "1", text: "why is login failing", ms: 310 });
  tx.log({ type: "say", turn: 1, text: "Let me look at the auth middleware." });
  tx.log({ type: "thinking", turn: 1, text: "a".repeat(5000) });
  tx.log({ type: "aside", turn: 1, text: "working notes" });
  tx.log({ type: "tool", turn: 1, id: "t1", label: "Read · auth.ts", detail: "x".repeat(2000) });
  tx.log({ type: "tool_result", turn: 1, id: "t1", ok: true, summary: "42 lines" });
  tx.log({ type: "screen", turn: 1, text: "`auth.ts:42`" });
  tx.log({ type: "screen", turn: 1, text: " never awaits.\n" });
  tx.log({ type: "say", turn: 1, text: "Found it, a missing await." });
  tx.session("sess-abc");
  tx.log({ type: "done", turn: 1 });
  await tx.close();
  return tx;
}

test("the jsonl keeps the call and leaves the token streams out", async () => {
  const tx = await recorded();
  const lines = (await readFile(tx.jsonlPath, "utf8")).trim().split("\n").map((l) => JSON.parse(l));
  const types = lines.map((l) => l.type);
  assert.deepEqual(types, ["call-start", "turn", "heard", "say", "tool", "tool_result", "screen", "screen", "say", "session", "done", "call-end"]);
  assert.ok(lines.every((l) => typeof l.t === "number"));
  assert.equal(lines.find((l) => l.type === "heard").ms, 310);
  // verbose tool input is kept but bounded
  assert.ok(lines.find((l) => l.type === "tool").detail.length < 700);
});

test("the markdown transcript reads as the call, with the session id for resuming", async () => {
  const tx = await recorded();
  const md = await readFile(tx.mdPath, "utf8");
  assert.match(md, /^# Buddy call · /);
  assert.match(md, /- cwd: `\/work`/);
  assert.match(md, /- Claude session: `sess-abc`/);
  assert.match(md, /## 1\. You: why is login failing/);
  assert.match(md, /\*\*Buddy said:\*\* Let me look at the auth middleware\. Found it, a missing await\./);
  assert.match(md, /\*\*Did:\*\* Read · auth\.ts/);
  assert.match(md, /\*\*On screen:\*\*\n\n`auth\.ts:42` never awaits\./);
  assert.doesNotMatch(md, /aaaa|working notes/);
});

test("closing twice does not write twice", async () => {
  const tx = await recorded();
  await tx.close();
  const lines = (await readFile(tx.jsonlPath, "utf8")).trim().split("\n");
  assert.equal(lines.filter((l) => l.includes('"call-end"')).length, 1);
});

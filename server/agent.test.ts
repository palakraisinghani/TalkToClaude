import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeSession } from "./agent.ts";

/**
 * A stand-in for the claude CLI, speaking just enough stream-json to exercise the session:
 * it answers each message with a line of text and a result, and its behaviour is steered by
 * environment variables: FAKE_STALE (a --resume of a session that is gone), FAKE_SLOW (each turn
 * takes a while), FAKE_DIE (exits on the first message).
 */
const bin = mkdtempSync(join(tmpdir(), "fake-claude-"));
writeFileSync(join(bin, "claude"), `#!/usr/bin/env node
const rl = require("readline").createInterface({ input: process.stdin });
const out = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
const resume = process.argv.includes("--resume");
if (resume && process.env.FAKE_STALE) {
  // like the real CLI: a hook notice, then a failed result for the first message, then exit
  out({ type: "system", subtype: "hook_started", session_id: "gone" });
  rl.once("line", () => { out({ type: "result", subtype: "error_during_execution", is_error: true, session_id: "gone" }); process.exit(1); });
} else {
  out({ type: "system", subtype: "init", session_id: "fresh" });
  let n = 0;
  rl.on("line", (l) => {
    const m = JSON.parse(l);
    if (m.type !== "user") return;
    if (process.env.FAKE_DIE) process.exit(3);
    const say = () => { out({ type: "assistant", session_id: "fresh", message: { content: [{ type: "text", text: "reply to " + m.message.content }] } }); out({ type: "result", subtype: "success", session_id: "fresh" }); };
    process.env.FAKE_SLOW ? setTimeout(say, 400 * ++n) : say();
  });
}
`);
chmodSync(join(bin, "claude"), 0o755);

function session(env: Record<string, string>, resume?: string) {
  const s = new ClaudeSession({ cwd: tmpdir(), systemPrompt: "", resume, env: { PATH: `${bin}:${process.env.PATH}`, ...env } });
  const events: any[] = [];
  s.on((turn, ev) => events.push({ turn, ...ev }));
  return { s, events };
}
const until = async (f: () => boolean, ms = 5000) => { const end = Date.now() + ms; while (!f() && Date.now() < end) await new Promise((r) => setTimeout(r, 20)); };
// the session spawns "claude" from PATH; point it at the fake for these tests
process.env.PATH = `${bin}:${process.env.PATH}`;

test("a session to resume that no longer exists falls back to a fresh one, and the message is not lost", async () => {
  const { s, events } = session({ FAKE_STALE: "1" }, "old-session-id");
  s.start();
  s.send("please do the task");
  await until(() => events.some((e) => e.kind === "done"));
  const text = events.filter((e) => e.kind === "text").map((e) => e.text).join("");
  assert.match(text, /reply to please do the task/);
  const done = events.find((e) => e.kind === "done");
  assert.equal(done.interrupted, false);
  assert.equal(done.sessionId, "fresh", "the dead session's id is not kept");
  s.close();
});

test("queued messages that are let go are reported, so their cards can close", async () => {
  const { s, events } = session({ FAKE_SLOW: "1" });
  s.start();
  const a = s.send("one");
  const b = s.send("two", { interrupt: false });
  const c = s.send("three", { interrupt: false });
  s.stop();
  await until(() => events.filter((e) => e.kind === "dropped").length >= 2);
  assert.deepEqual(events.filter((e) => e.kind === "dropped").map((e) => e.turn).sort(), [b, c].sort());
  assert.ok(a < b);
  s.close();
});

test("after close, nothing more is reported", async () => {
  const { s, events } = session({ FAKE_SLOW: "1" });
  s.start();
  s.send("hello");
  s.close();
  await new Promise((r) => setTimeout(r, 900));
  assert.equal(events.filter((e) => e.kind === "done" || e.kind === "text").length, 0);
});

test("a side question to a process that died fails at once, not after a long wait", async () => {
  const { s } = session({ FAKE_DIE: "1" });
  s.start();
  await new Promise((r) => setTimeout(r, 200));
  const q = s.sideQuestion("what are you doing?", [], 30_000);
  s.send("go");
  const t = Date.now();
  await assert.rejects(q);
  assert.ok(Date.now() - t < 3000, "rejected when the process went, not at the timeout");
  s.close();
});

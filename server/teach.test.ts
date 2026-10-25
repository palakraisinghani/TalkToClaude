import { test } from "node:test";
import assert from "node:assert/strict";
import { Call } from "./call.ts";
import { centralName, setCentralName, CENTRAL_ID, CENTRAL_NAME } from "./identity.ts";
import { projectFor } from "./projects.ts";

const make = () => {
  const sent: any[] = [];
  const projects = [projectFor("/tmp/a/felix", 0, [], { name: "Felix" }), projectFor("/tmp/a/iris", 1, ["felix"], { name: "Iris" })];
  const call = new Call({ projects, home: "/tmp/a", systemPrompt: "", centralPrompt: "", callsDir: "/tmp/a", rewriter: { toSpeech: async (x) => x }, send: (m) => sent.push(m) });
  // telling the agent would start a real Claude session; here it is enough to see it was asked
  const told: string[] = [];
  (call as any).ask = (_id: string, text: string) => told.push(text);
  return { call, sent, told };
};

test("how the lead says a name is kept as aliases, minus anything that is someone else's", () => {
  const { call, sent } = make();
  assert.deepEqual(call.teach("felix", ["feelix", "felix", "iris", "phelix", "two words"]), ["feelix", "phelix"]);
  const roster = sent.filter((m) => m.type === "roster").pop();
  assert.deepEqual(roster.projects.find((p: any) => p.id === "felix").aliases, ["feelix", "phelix"]);
});

test("the assistant can be renamed: her id stays, her name and built-in spellings change, and she is told", () => {
  const { call, sent, told } = make();
  try {
    assert.match(call.rename(CENTRAL_ID, "Fenix") ?? "", /sounds too much like Felix/);
    assert.equal(call.rename(CENTRAL_ID, "Nova"), null);
    assert.equal(centralName(), "Nova");
    const c = sent.filter((m) => m.type === "central").pop();
    assert.equal(c.name, "Nova");
    assert.equal(c.id, CENTRAL_ID);
    const ada = sent.filter((m) => m.type === "roster").pop().projects.find((p: any) => p.id === CENTRAL_ID);
    assert.equal(ada.name, "Nova");
    assert.deepEqual(ada.aliases, []); // Ada's mishearings do not follow her to a new name
    assert.match(told.pop() ?? "", /renamed you from Ada to Nova/);
  } finally {
    setCentralName(CENTRAL_NAME);
  }
});

test("a picture pasted as text is recovered from the file the agent was working with, and the agent is told once", async () => {
  const { mkdtemp, mkdir, writeFile } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const dir = await mkdtemp(join(tmpdir(), "cc-rescue-"));
  await mkdir(join(dir, "output", "gallery"), { recursive: true });
  await writeFile(join(dir, "output", "gallery", "julia.png"), "png");
  const p0 = projectFor(dir, 0, [], { name: "Milo" });
  const call = new Call({ projects: [p0], home: dir, systemPrompt: "", centralPrompt: "", callsDir: dir, rewriter: { toSpeech: async (x) => x }, send: () => {} });
  const p = (call as any).projects.get(p0.id);
  await (call as any).handle(p, 1, { kind: "tool", id: "t1", name: "Bash", input: { command: `python -c "im = Image.open('output/gallery/julia.png'); im.save('/tmp/julia_b64.txt')"` } });
  assert.equal(await call.rescueImage(p0.id), join(dir, "output", "gallery", "julia.png"));
  assert.equal(p.notes.length, 1);
  assert.match(p.notes[0], /never as base64/);
  await call.rescueImage(p0.id);
  assert.equal(p.notes.length, 1); // told once, not every time
});

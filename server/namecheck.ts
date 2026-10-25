import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { seeded, take, wavSamples } from "./augment.ts";
import { voices } from "./tts.ts";
import type { STT } from "./types.ts";

const run = promisify(execFile);

/**
 * How well a name comes through when said, before an agent is given it: the name is said in
 * several system voices (the lead's own accent among them when known), each take given the drift
 * a real voice, mic and room add, and the recogniser the app uses writes down what it hears —
 * prompted with the team's names, as on a call. The share it gets right is what the lead will get.
 * Eight takes: a few seconds, and far more telling than rules about how a name looks.
 */
export interface NameTest {
  heard: number;
  total: number;
  /** What it was heard as when it was not heard right, for the dialog to show. */
  misheard: string[];
  /** Another agent's name it was taken for, if any. */
  takenFor: string | null;
}

const ACCENT_VOICES: Record<string, string[]> = {
  "indian english": ["Rishi", "Tara", "Aman"],
  "british english": ["Daniel", "Kate", "Serena"],
  "australian english": ["Karen", "Lee"],
};
const ANY = ["Samantha", "Daniel", "Karen", "Moira", "Rishi", "Tara"];

export async function testName(name: string, others: string[], stt: STT, accent = ""): Promise<NameTest> {
  const have = (await voices()).map((v) => v.replace(/\s*\(.*$/, ""));
  const preferred = ACCENT_VOICES[accent.toLowerCase()] ?? [];
  const pool = [...new Set([...preferred, ...ANY])].filter((v) => have.includes(v));
  // the lead's own accent counts double: two of them, then a spread of others
  const chosen = [...pool.filter((v) => preferred.includes(v)).slice(0, 2), ...pool.filter((v) => !preferred.includes(v)).slice(0, 4 - Math.min(2, preferred.length))].slice(0, 4);
  const dir = await mkdtemp(join(tmpdir(), "cc-name-"));
  const rnd = seeded(name.length * 7919 + 17);
  const names = [...new Set([name, ...others])];
  let heard = 0, total = 0;
  const misheard: string[] = [];
  const taken = new Map<string, number>();
  try {
    // made all at once, then heard one by one: saying is quick and parallel, hearing is the cost
    const takes = chosen.flatMap((voice) => [165, 195].map((rate) => ({ voice, rate, file: join(dir, `${voice}-${rate}.wav`) })));
    await Promise.all(takes.map((t) => run("say", ["-v", t.voice, "-r", String(t.rate), "-o", t.file, "--data-format=LEI16@16000", "--", name])));
    for (const t of takes) {
      const text = await stt.transcribe(take(wavSamples(await readFile(t.file)), rnd), { names });
      total++;
      const has = (n: string) => new RegExp(`\\b${n.replace(/[^\w ]/g, "")}\\b`, "i").test(text);
      if (has(name)) heard++;
      else {
        if (misheard.length < 4 && text) misheard.push(text);
        const other = others.find(has);
        if (other) taken.set(other, (taken.get(other) ?? 0) + 1);
      }
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const takenFor = [...taken].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  return { heard, total, misheard: [...new Set(misheard)], takenFor };
}

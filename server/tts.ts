import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

/**
 * Speech made on this machine, as audio, so the page can place each voice in space.
 *
 * The browser's own speech goes straight to the speakers and cannot be panned. On macOS the server
 * can make the same sentence with `say`, in the same system voices, as a WAV file; the page then
 * plays it through Web Audio with each agent at its own position, left or right. On headphones you
 * hear who is talking before you hear what they say. Elsewhere this is unavailable and the page
 * keeps using the browser's speech.
 */
export const canSpeak = process.platform === "darwin";

let installed: Promise<string[]> | null = null;
/**
 * The system voices this Mac has, as `say -v` accepts them. Each line of `say -v ?` is the name
 * (sometimes with a language in brackets, "Daniel (English (UK))"), the locale, then a sample.
 */
export function voices(): Promise<string[]> {
  installed ??= run("say", ["-v", "?"]).then(
    ({ stdout }) => [...new Set(stdout.split("\n").map((l) => /^(.+?)\s+[a-z]{2,3}[_-][A-Za-z0-9]+\s+#/.exec(l)?.[1].trim()).filter((v): v is string => !!v))],
    () => [],
  );
  return installed;
}
/** "Daniel (English (UK))" → "daniel", for matching the names the page asks for. */
const base = (v: string) => v.replace(/\s*\(.*$/, "").trim().toLowerCase();

/** The first of an agent's candidate voices this Mac has, or a sensible default. */
export async function pickVoice(candidates: string[]): Promise<string> {
  const have = await voices();
  for (const c of candidates) {
    const hit = have.find((v) => v === c) ?? have.find((v) => base(v) === base(c));
    if (hit) return hit;
  }
  return have.find((v) => base(v) === "samantha") ?? have[0] ?? "Samantha";
}

/**
 * One sentence as a 16-bit mono WAV. `rate` is the agent's speaking rate as the page uses it (1 is
 * normal), turned into say's words per minute.
 */
export async function synthesize(text: string, candidates: string[], rate = 1): Promise<Buffer> {
  const voice = await pickVoice(candidates);
  const dir = await mkdtemp(join(tmpdir(), "cc-tts-"));
  const file = join(dir, "s.wav");
  try {
    const wpm = String(Math.round(185 * Math.max(0.6, Math.min(1.8, rate))));
    // "--" keeps a sentence that starts with a dash from being read as an option
    await run("say", ["-v", voice, "-r", wpm, "-o", file, "--data-format=LEI16@22050", "--", text.slice(0, 2000)], { timeout: 20_000 });
    return await readFile(file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

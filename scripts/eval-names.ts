// How well are names recognised in the lead's voice? Run: node scripts/eval-names.ts [--stt[=fast|accurate|moonshine]]
//
// macOS only. It synthesises "leads" with the system voices (say) — Indian-English ones among
// them — and gives every take the variation a real person, mic and room add: pitch and speed drift,
// a different mic tone, room echo, background noise, automatic gain and ragged start and end. Clean
// synthetic takes said every name identically and made everything look perfect; these do not.
//
// For each lead it teaches every agent name as the page does (tries judged by assess(), the odd one
// dropped), then checks fresh takes — the name alone, after "hey", before a command — and ordinary
// words that must not be taken for a name. With --stt each take is also transcribed by the chosen
// recogniser, prompted with the team's names, and routed as the page routes it: text first, then the
// voice match, a weak one only when the words sound like the name. Audio is cached between runs.
//
// The thresholds in server/voiceprint.ts (STRONG, WEAK) were chosen from these numbers; re-run
// after changing them, or the features, and compare.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { durationMs, features, MAX_SEARCH_MS, MAX_TRIES, Voiceprints } from "../server/voiceprint.ts";
import { makeSTT } from "../server/stt.ts";
import { seeded, take as augmentTake } from "../server/augment.ts";
import { route, soundsLike } from "../web/route.js";
import { classify } from "../web/attention.js";

const CACHE = join(tmpdir(), "claudecall-eval-names");
const SPEAKERS: [string, string][] = [["Rishi", "Indian English"], ["Tara", "Indian English"], ["Samantha", ""], ["Daniel", ""], ["Karen", ""], ["Moira", ""]];
const NAMES = ["Ada", "Juno", "Milo", "Rex", "Iris", "Otto", "Kai", "Wren"];
const DECOYS = ["hello", "okay", "yes", "thanks", "next", "Juniper", "Phoenix", "Remy", "maybe", "other", "order"];
const sttArg = process.argv.find((a) => a.startsWith("--stt"));
const stt = sttArg ? makeSTT(sttArg.split("=")[1] ?? "fast") : null;
await stt?.ready();

const clip = (spk: string, file: string, text: string, rate: number) => {
  const path = join(CACHE, spk, `${file}.wav`);
  if (!existsSync(path)) {
    mkdirSync(join(CACHE, spk), { recursive: true });
    execFileSync("say", ["-v", spk, "-r", String(rate), "-o", path, "--data-format=LEI16@16000", text]);
  }
  return wav(path);
};
function wav(path: string): Float32Array {
  const b = readFileSync(path);
  for (let o = 12; o < b.length;) {
    const id = b.toString("ascii", o, o + 4), size = b.readUInt32LE(o + 4);
    if (id === "data") return Float32Array.from({ length: size / 2 }, (_, i) => b.readInt16LE(o + 8 + 2 * i) / 32768);
    o += 8 + size + (size % 2);
  }
  return new Float32Array(0);
}

// ---------- one take, as a real mic and room deliver it: see server/augment.ts ----------
const rnd = seeded(12345);
const take = (a: Float32Array) => augmentTake(a, rnd);

// ---------- the run ----------
const projects = NAMES.map((n, i) => ({ id: n.toLowerCase(), name: n, central: i === 0 }));
type Tally = [number, number, number]; // right, wrong agent, missed
const tallies: Record<string, Record<string, Tally>> = {};
const learnt: Record<string, [number, number, number]> = {}; // learned, names, tries
const decoyHits: Record<string, [number, number]> = {};

for (const [spk, accent] of SPEAKERS) {
  if (clip(spk, "probe", "Ada", 180).length < 3200) { console.log(`skipping ${spk}: voice not installed`); continue; }
  const group = accent ? "Indian English" : "other accents";
  const v = new Voiceprints(mkdtempSync(join(tmpdir(), "vp-")));
  for (const n of NAMES) {
    const takes = [150, 170, 190, 210, 180].map((r) => clip(spk, `${n}.${r}`, n, r));
    const session: number[][][] = [];
    let a: any = null, k = 0;
    while (k < MAX_TRIES && !a?.confident) {
      session.push(features(take(takes[k++ % 4])));
      a = v.assess(n.toLowerCase(), session);
      session.splice(0, session.length, ...a.keep.map((i: number) => session[i]));
    }
    await v.add(n.toLowerCase(), session, !!a?.confident);
    const l = (learnt[group] ??= [0, 0, 0]);
    l[1]++; l[2] += k; if (a?.confident) l[0]++;
  }
  // what the page would do with this take: the agent it goes to, or null
  const decide = async (audio: Float32Array): Promise<string | null> => {
    const text = stt ? await stt.transcribe(audio, { names: NAMES }) : "";
    const r = stt ? route(text, projects) : { kind: "ask" };
    if ((r.kind === "focus" || r.kind === "address") && "project" in r) return r.project as string;
    if (r.kind !== "ask" || (stt && classify(text) !== null)) return null;
    const m = durationMs(audio) <= MAX_SEARCH_MS ? v.match(features(audio), projects.map((p) => p.id)) : null;
    if (!m) return null;
    const name = NAMES.find((x) => x.toLowerCase() === m.id)!;
    return m.strength === "strong" || (stt && soundsLike(text, name, { accent })) ? m.id : null;
  };
  for (const n of NAMES) {
    for (const [kind, file, text] of [["name alone", `${n}.180`, n], ["hey <name>", `hey-${n}`, `hey ${n}`], ["name + command", `cmd-${n}`, `${n}, run the tests`]]) {
      const got = await decide(take(clip(spk, file, text, kind === "name alone" ? 180 : 185)));
      ((tallies[group] ??= {})[kind] ??= [0, 0, 0])[!got ? 2 : got === n.toLowerCase() ? 0 : 1]++;
    }
  }
  for (const d of DECOYS) {
    const h = (decoyHits[group] ??= [0, 0]);
    h[1]++;
    if (await decide(take(clip(spk, `decoy-${d}`, d, 185)))) h[0]++;
  }
}

const pct = (x: number, n: number) => `${Math.round((100 * x) / Math.max(1, n))}%`.padStart(4);
console.log(`\nrouting by ${stt ? `transcript (${sttArg?.split("=")[1] ?? "fast"}) + voice, as the page does` : "voice alone"}; every take varied like a real mic and room`);
for (const group of Object.keys(learnt)) {
  const [l, n, k] = learnt[group];
  console.log(`\n${group}: names learned ${l}/${n} (${pct(l, n).trim()}), ${(k / n).toFixed(1)} tries each`);
  for (const [kind, [r, w, m]] of Object.entries(tallies[group])) console.log(`  ${kind.padEnd(15)} right ${pct(r, r + w + m)}   wrong agent ${pct(w, r + w + m)}   missed ${pct(m, r + w + m)}`);
  const [h, d] = decoyHits[group];
  console.log(`  ordinary words taken for a name: ${h}/${d} (${pct(h, d).trim()})`);
}

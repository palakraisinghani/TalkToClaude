import type { Mode } from "./types.ts";

const CONTRACTIONS: [RegExp, string][] = [
  [/\bcan't\b/gi, "cannot"],
  [/\bwon't\b/gi, "will not"],
  [/\bdon't\b/gi, "do not"],
  [/\bdoesn't\b/gi, "does not"],
  [/\bisn't\b/gi, "is not"],
  [/\baren't\b/gi, "are not"],
  [/\bwasn't\b/gi, "was not"],
  [/\bdidn't\b/gi, "did not"],
  [/\bshouldn't\b/gi, "should not"],
];

function splitWords(s: string): string {
  return s
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2")
    .replace(/_/g, " ");
}

function fileName(path: string): string {
  const base = path.split("/").filter(Boolean).pop() ?? path;
  return base.replace(/\./g, " dot ");
}

/** Deterministic cleanup for anything headed to the TTS queue. */
export function clean(text: string, mode: Mode = "visual"): string {
  let t = text;
  t = t.replace(/```[\s\S]*?```/g, () =>
    mode === "visual" ? " I have left a code snippet on screen. " : " the code is in a file I can save. ",
  );
  t = t.replace(/`([^`]+)`/g, "$1");
  t = t.replace(/https?:\/\/\S+/g, "a link");
  t = t.replace(/(?:\.{0,2}\/)?(?:[\w@.-]+\/)+[\w@.-]+/g, (m) => fileName(m));
  t = t.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  t = t.replace(/^\s*[-*+]\s+/gm, "");
  t = t.replace(/^\s*\d+[.)]\s+/gm, "");
  t = t.replace(/^\s*\|?[\s:|-]{3,}\|?\s*$/gm, "");
  t = t.replace(/\|/g, ", ");
  t = t.replace(/(\*\*|__|\*|_(?=\S))/g, "");
  t = t.replace(/\be\.g\./gi, "for example").replace(/\bi\.e\./gi, "that is");
  t = t.replace(/->|=>/g, " to ").replace(/&/g, " and ");
  t = t.replace(/\b[a-z]+(?:[A-Z][a-z0-9]*)+\b|\b\w+_\w+\b/g, splitWords);
  t = t.replace(/\b(\w+) dot (ts|js|py|md|json)\b/g, "$1 dot $2");
  for (const [re, rep] of CONTRACTIONS) t = t.replace(re, rep);
  t = t.replace(/[#*~^<>{}[\]\\]/g, " ");
  return t.replace(/\s+/g, " ").trim();
}

/** Split text into sentences; the trailing fragment is returned as rest. */
export function splitSentences(text: string): { sentences: string[]; rest: string } {
  const sentences: string[] = [];
  const re = /[^.!?\n]+(?:[.!?]+|\n)(?=\s|$)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    const s = m[0].trim();
    if (s) sentences.push(s);
    last = re.lastIndex;
  }
  return { sentences, rest: text.slice(last) };
}

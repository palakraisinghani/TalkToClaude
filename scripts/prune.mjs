// Trim a bundled app's node_modules to what ClaudeCall actually loads. Run by bundle.sh:
//   node scripts/prune.mjs <app dir>
//
// npm installs everything a package might want; most of it is never touched here. Measured on the
// Mac build, this takes the app from about 390 MB to about 110 MB:
//   - the server imports only ws, @huggingface/transformers and sharp: their dependency tree is
//     kept, followed through package-lock.json, and nothing else. transformers' own copy of
//     onnxruntime-web (108 MB of browser runtimes) is left out: in Node it uses onnxruntime-node,
//     and the browser build it carries is compiled into its own file anyway;
//   - the page is sent three files of onnxruntime-web (the voice detector's runtime), the voice
//     detector's bundle and model, and one file of mermaid (diagrams) — as recorded from a live
//     call — so of those packages only these files stay, and none of mermaid's 40-odd libraries;
//   - source maps, type declarations and readmes go everywhere.
// scripts/smoke.sh then checks the result still starts and still hears.

import { existsSync, lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

const app = process.argv[2];
if (!app) throw new Error("usage: node scripts/prune.mjs <app dir>");
const lock = JSON.parse(readFileSync(join(app, "package-lock.json"), "utf8")).packages;

// what the server imports (server/*.ts), and what it must not follow
const SERVER_ROOTS = ["ws", "@huggingface/transformers", "sharp"];
const NOT_AT_RUNTIME = new Set(["onnxruntime-web"]);
// served to the page as files (server/index.ts STATIC), each with the files the page asks for
const SERVED = {
  "node_modules/onnxruntime-web": ["dist/ort.wasm.min.js", "dist/ort-wasm-simd-threaded.mjs", "dist/ort-wasm-simd-threaded.wasm"],
  "node_modules/@ricky0123/vad-web": ["dist/bundle.min.js", "dist/silero_vad_v5.onnx", "dist/silero_vad_legacy.onnx", "dist/vad.worklet.bundle.min.js"],
  "node_modules/mermaid": ["dist/mermaid.min.js"],
};

/** Where `name` resolves from the package at `from`, the way Node looks it up. */
function resolve(from, name) {
  let base = from;
  for (;;) {
    const at = `${base ? `${base}/` : ""}node_modules/${name}`;
    if (lock[at] && existsSync(join(app, at))) return at;
    if (!base) return null;
    const i = base.lastIndexOf("/node_modules/");
    base = i < 0 ? "" : base.slice(0, i);
  }
}

const keep = new Set(Object.keys(SERVED));
const todo = SERVER_ROOTS.map((n) => resolve("", n));
while (todo.length) {
  const at = todo.pop();
  if (!at || keep.has(at)) continue;
  keep.add(at);
  const p = lock[at];
  for (const name of Object.keys({ ...p.dependencies, ...p.optionalDependencies, ...p.peerDependencies })) {
    if (NOT_AT_RUNTIME.has(name)) continue;
    todo.push(resolve(at, name));
  }
}

let removed = 0;
// deepest first, so a kept package inside a removed one is never orphaned the wrong way round
for (const at of Object.keys(lock).filter((k) => k.startsWith("node_modules/")).sort((a, b) => b.length - a.length)) {
  // a package nested inside a kept one is judged on its own; one under a removed one goes with it
  if (keep.has(at)) continue;
  if (existsSync(join(app, at))) { rmSync(join(app, at), { recursive: true, force: true }); removed++; }
}

// the served packages: only the files the page loads
for (const [at, files] of Object.entries(SERVED)) {
  const dir = join(app, at);
  const wanted = new Set(files.map((f) => join(dir, f)));
  const sweep = (d) => {
    for (const e of readdirSync(d)) {
      const f = join(d, e);
      if (lstatSync(f).isDirectory()) { sweep(f); if (!readdirSync(f).length) rmSync(f, { recursive: true }); }
      else if (!wanted.has(f) && e !== "package.json" && !/^licen[cs]e/i.test(e)) rmSync(f);
    }
  };
  sweep(dir);
  for (const f of files) if (!f.includes("legacy") && !f.includes("worklet") && !existsSync(join(dir, f))) throw new Error(`${at}/${f} is missing`);
}

// GPU back ends for onnxruntime (CUDA, TensorRT): speech recognition runs on the CPU
const ort = join(app, "node_modules", "onnxruntime-node", "bin");
if (existsSync(ort)) {
  const gpu = /providers_(cuda|tensorrt|rocm|migraphx|openvino)|libcudnn|libcublas|libcufft|libcurand|libnvinfer/i;
  const sweepGpu = (d) => { for (const e of readdirSync(d)) { const f = join(d, e); if (lstatSync(f).isDirectory()) sweepGpu(f); else if (gpu.test(e)) rmSync(f); } };
  sweepGpu(ort);
}

// command-line shortcuts: nothing here runs them, and many now point at removed packages
rmSync(join(app, "node_modules", ".bin"), { recursive: true, force: true });

// everywhere: maps, type declarations, readmes and changelogs
const junk = /\.(map|d\.ts|d\.mts|d\.cts|md|markdown)$/i;
const tidy = (d) => {
  for (const e of readdirSync(d)) {
    const f = join(d, e);
    if (lstatSync(f).isDirectory()) tidy(f);
    else if (junk.test(e) && !/^licen[cs]e/i.test(e)) rmSync(f);
  }
};
tidy(join(app, "node_modules"));
console.log(`pruned ${removed} packages; kept ${keep.size}`);

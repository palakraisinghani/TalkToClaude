import { test } from "node:test";
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { join } from "node:path";

/**
 * Every module must actually load. `node --check` parses a file but does not instantiate it, so
 * it misses scope errors such as a redeclared binding — which only surface when the server boots.
 */
test("every server and web module loads", async () => {
  const here = fileURLToPath(new URL(".", import.meta.url));
  const web = join(here, "..", "web");
  const files = [
    ...(await readdir(here)).filter((f) => f.endsWith(".ts") && !f.endsWith(".test.ts")).map((f) => join(here, f)),
    // the page's own modules, apart from the ones that need a browser at import time
    ...(await readdir(web)).filter((f) => f.endsWith(".js") && !f.endsWith(".test.js") && !["app.js", "voice.js", "listen.js"].includes(f)).map((f) => join(web, f)),
  ];
  assert.ok(files.length > 10, "expected to find the modules");
  for (const f of files) {
    // index.ts starts a server and loads a model; loading it here would be a side effect
    if (f.endsWith("index.ts")) continue;
    await assert.doesNotReject(() => import(f), `${f} failed to load`);
  }
});

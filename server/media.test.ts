import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Media, pageMedia } from "./media.ts";

test("a web page is followed to the picture or video it advertises", () => {
  const html = `<html><head><meta property="og:image" content="https://media.example/cat.gif"><meta property="og:video" content="/v/cat.mp4"></head></html>`;
  assert.equal(pageMedia(html, "https://example.com/gifs/cat"), "https://example.com/v/cat.mp4"); // video first, made absolute
  assert.equal(pageMedia(`<meta name="twitter:image" content="https://x/a.png?w=1&amp;h=2">`, "https://x/"), "https://x/a.png?w=1&h=2");
  assert.equal(pageMedia("<p>nothing</p>", "https://x/"), null);
});

test("a local file gets a private link; anything that is not media, or not there, says why", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-media-"));
  await writeFile(join(dir, "a.gif"), Buffer.from("GIF89a"));
  await writeFile(join(dir, "notes.txt"), "x");
  const m = new Media(join(dir, "cache"));
  const ok = await m.local(dir, "a.gif");
  assert.ok("url" in ok && /^\/media\/[\w-]{20,}$/.test(ok.url) && ok.kind === "image" && ok.mime === "image/gif");
  assert.match((await m.local(dir, "notes.txt") as any).error, /not a picture or video/);
  assert.match((await m.local(dir, "missing.png") as any).error, /no such file/);
});

test("media is served by token only, with range requests so a video can seek", async () => {
  const dir = await mkdtemp(join(tmpdir(), "cc-media-"));
  await writeFile(join(dir, "clip.mp4"), Buffer.from("0123456789"));
  const m = new Media(join(dir, "cache"));
  const r = await m.local(dir, "clip.mp4") as any;
  const fake = (range?: string) => {
    const out: any = { status: 0, headers: {}, body: "" };
    const res: any = { writeHead: (s: number, h: any) => { out.status = s; out.headers = h ?? {}; return res; }, end: () => {}, write: (c: Buffer) => (out.body += c), on: () => res, once: () => res, emit: () => true, removeListener: () => res };
    return { req: { headers: range ? { range } : {} }, res, out };
  };
  const a = fake("bytes=2-5");
  assert.equal(await m.serve(a.req, a.res, r.url.split("/").pop()), true);
  assert.equal(a.out.status, 206);
  assert.equal(a.out.headers["content-range"], "bytes 2-5/10");
  assert.equal(await m.serve(fake().req, fake().res, "not-a-token"), false);
});

test("a picture is sent as a light WebP copy with a preview and its size; the original stays reachable", async () => {
  const sharp = (await import("sharp")).default;
  const dir = await mkdtemp(join(tmpdir(), "cc-media-"));
  // a noisy 2000×1200 picture, the kind that is heavy as PNG
  const raw = Buffer.alloc(2000 * 1200 * 3);
  // smooth colour with fine grain, like a render or a photo (a repeating pattern would be tiny as PNG)
  let seed = 7;
  for (let y = 0; y < 1200; y++) for (let x = 0; x < 2000; x++) {
    seed = (seed * 16807) % 2147483647;
    const g = (seed % 24) - 12, i = (y * 2000 + x) * 3;
    raw[i] = Math.max(0, Math.min(255, (x * 255) / 2000 + g));
    raw[i + 1] = Math.max(0, Math.min(255, (y * 255) / 1200 + g));
    raw[i + 2] = Math.max(0, Math.min(255, 128 + 100 * Math.sin(x / 90) * Math.cos(y / 70) + g));
  }
  await sharp(raw, { raw: { width: 2000, height: 1200, channels: 3 } }).png().toFile(join(dir, "big.png"));
  const secretFile = join(dir, "secret");
  const m = new Media(join(dir, "tmp"), { cacheDir: join(dir, "cache"), secretFile });
  await m.init();
  // the first look is never held up by the conversion: the original, at once, with its size
  const t0 = Date.now();
  const first = (await m.local(dir, "big.png")) as any;
  assert.ok(Date.now() - t0 < 250, `took ${Date.now() - t0}ms`);
  assert.equal(first.mime, "image/png");
  assert.ok(first.width <= 1400 && Math.abs(first.width / first.height - 2000 / 1200) < 0.01, "space is held");
  // a page far away waits a moment for the light copy, which is the same one made in the background
  const r = (await m.local(dir, "big.png", 5000)) as any;
  assert.equal(r.kind, "image");
  assert.equal(r.mime, "image/webp");
  assert.ok(r.width <= 1400 && r.height <= 1400 && Math.abs(r.width / r.height - 2000 / 1200) < 0.01, `${r.width}x${r.height}`);
  assert.match(r.placeholder, /^data:image\/webp;base64,/);
  assert.ok(r.placeholder.length < 1000);
  assert.notEqual(r.full, r.url);
  // the same link after a restart, so the browser's cache still has it
  const again = new Media(join(dir, "tmp"), { cacheDir: join(dir, "cache"), secretFile });
  await again.init();
  assert.equal(((await again.local(dir, "big.png")) as any).url, r.url);
  // served with a long cache lifetime
  const out: any = {};
  const res: any = { writeHead: (s: number, h: any) => { out.status = s; out.headers = h; return res; }, end: () => {}, on: () => res, once: () => res, emit: () => true, write: () => true, removeListener: () => res };
  assert.equal(await again.serve({ headers: {} }, res, r.url.split("/").pop()), true);
  assert.match(out.headers["cache-control"], /immutable/);
});

test("a picture that arrives as data is cached by its contents and sent the same way", async () => {
  const sharp = (await import("sharp")).default;
  const dir = await mkdtemp(join(tmpdir(), "cc-media-"));
  const png = await sharp({ create: { width: 64, height: 40, channels: 3, background: "#d77757" } }).png().toBuffer();
  const m = new Media(join(dir, "tmp"), { cacheDir: join(dir, "cache") });
  await m.init();
  const r = (await m.fromData(`data:image/png;base64,${png.toString("base64")}`, 5000)) as any;
  assert.equal(r.kind, "image");
  assert.ok(r.url && r.full && r.placeholder);
  assert.equal(r.width, 64);
  assert.deepEqual(await m.fromData("data:text/plain;base64,aGk="), { error: "not a picture" });
});

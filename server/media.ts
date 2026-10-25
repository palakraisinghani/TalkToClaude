import { createHash, createHmac, randomBytes } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

/**
 * Pictures, GIFs and videos an agent puts on the canvas, from its folder or from the web.
 *
 * The page cannot load them itself: plain HTTP carries no access code, so a file on this machine
 * is not reachable by path, and many sites refuse to be embedded elsewhere or link to a page
 * rather than the image ("giphy.com/gifs/…"). So the page asks over the socket, and is given a
 * link of its own: /media/<token>, unguessable, valid for this server's life, served with range
 * requests so a video can seek. Web media is fetched here once, following a page to the image
 * or video it advertises, and kept in a temp folder.
 *
 * Pictures are made light before they are sent: resized to fit 1400px and turned into WebP
 * (animated, for a GIF), kept in a cache on disk so it happens once per picture. On real
 * images that came to 73–86% smaller: a 1.1MB PNG to 154KB, a 3.2MB GIF to 861KB, in 0.1–0.9s.
 * Each comes with a 24px preview of about 150 bytes, shown at once while the picture loads, and
 * its size, so the page holds the space. Its link is the same every time (a keyed hash of the
 * picture, not a random token), so the browser's cache keeps it across reloads and restarts.
 * The original stays reachable for full-size viewing and copying.
 */

export type MediaKind = "image" | "video";
export type MediaResult =
  | { url: string; kind: MediaKind; mime: string; full?: string; placeholder?: string; width?: number; height?: number; direct?: boolean }
  | { error: string };

/** What the display copy of a picture is made to fit, and how hard WebP compresses it. */
const DISPLAY_PX = 1400;
const WEBP = { quality: 80, effort: 4 };
const CACHE_VERSION = "v1"; // change when the display settings change, so old copies are not reused

const TYPES: Record<string, [MediaKind, string]> = {
  ".png": ["image", "image/png"], ".jpg": ["image", "image/jpeg"], ".jpeg": ["image", "image/jpeg"],
  ".gif": ["image", "image/gif"], ".webp": ["image", "image/webp"], ".svg": ["image", "image/svg+xml"],
  ".avif": ["image", "image/avif"], ".bmp": ["image", "image/bmp"], ".ico": ["image", "image/x-icon"],
  ".mp4": ["video", "video/mp4"], ".m4v": ["video", "video/mp4"], ".webm": ["video", "video/webm"],
  ".mov": ["video", "video/quicktime"], ".ogv": ["video", "video/ogg"],
};
const MAX_BYTES = 200 * 1024 * 1024; // a long screen recording, not a film
const FETCH_TIMEOUT_MS = 20_000;
const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36";

interface Display { file: string; useOriginal: boolean; placeholder: string; width: number; height: number }

const kindOf = (type: string): MediaKind | null => (type.startsWith("image/") ? "image" : type.startsWith("video/") ? "video" : null);
const extFor = (type: string) => Object.entries(TYPES).find(([, [, t]]) => t === type)?.[0] ?? "";

export class Media {
  private tokens = new Map<string, { file: string; type: string; lasting: boolean }>();
  private byKey = new Map<string, MediaResult>();
  private making = new Map<string, Promise<Display | null>>();
  private dir: string;
  private cacheDir: string;
  private secretFile: string | null;
  private secret: Buffer = randomBytes(32);
  private sharp: any = null;
  private waitMs = 0;
  private proxy = false;

  constructor(dir = join(tmpdir(), "claudecall-media"), { cacheDir = join(dir, "cache"), secretFile = null as string | null } = {}) {
    this.dir = dir;
    this.cacheDir = cacheDir;
    this.secretFile = secretFile;
  }

  /** Load the image library and the key that keeps links the same across restarts. */
  async init(): Promise<void> {
    this.sharp = (await import("sharp").catch(() => null))?.default ?? null;
    await mkdir(this.cacheDir, { recursive: true });
    if (!this.secretFile) return;
    const had = await readFile(this.secretFile).catch(() => null);
    if (had?.length === 32) { this.secret = had; return; }
    await writeFile(this.secretFile, this.secret, { mode: 0o600 });
  }

  /**
   * A link to a file. With a `key` (a hash of what the file is) the link is the same every time,
   * so the browser can keep it; without one it is random and lasts this server's life.
   */
  private issue(file: string, type: string, kind: MediaKind, key?: string): MediaResult & { url: string } {
    const token = key ? createHmac("sha256", this.secret).update(key).digest("base64url").slice(0, 32) : randomBytes(18).toString("base64url");
    this.tokens.set(token, { file, type, lasting: !!key });
    return { url: `/media/${token}`, kind, mime: type };
  }

  /** What a picture is, for caching: its path, size and time, or its bytes. */
  private async keyOf(file: string): Promise<string> {
    const s = await stat(file);
    return createHash("sha1").update(`${file}|${s.size}|${s.mtimeMs}`).digest("hex");
  }

  /**
   * A picture ready to send. Never held up by making its light copy: converting a big animated
   * GIF takes seconds (3.3s for an 80-frame one), while the original, on this machine, loads in
   * milliseconds. So: a light copy already made is used at once; otherwise the original goes now,
   * with its size so the page holds the space, and the light copy is made in the background for
   * next time. `waitMs` lets a far-away page (a phone on the network, where bytes cost time) wait
   * a little for the light copy before taking the original.
   */
  private async picture(file: string, type: string, key: string, waitMs = 0): Promise<MediaResult> {
    const full = this.issue(file, type, "image", `${key}|orig`);
    if (!this.sharp || type === "image/svg+xml" || type === "image/x-icon") return { ...full, full: full.url };
    const ready = (shown: Display): MediaResult => {
      const view = shown.useOriginal ? full : this.issue(shown.file, "image/webp", "image", `${key}|${CACHE_VERSION}`);
      return { ...view, full: full.url, placeholder: shown.placeholder, width: shown.width, height: shown.height };
    };
    const cached = await this.cachedDisplay(key);
    if (cached) return ready(cached);
    let d = this.making.get(key);
    if (!d) {
      d = this.display(file, type, key).catch(() => null);
      this.making.set(key, d);
      d.finally(() => this.making.delete(key));
    }
    if (waitMs > 0) {
      const shown = await Promise.race([d, new Promise<null>((r) => setTimeout(() => r(null), waitMs))]);
      if (shown) return ready(shown);
    }
    // the original now, with its size: reading a picture's header is quick even when decoding is not
    const meta = await this.sharp(file, { animated: true }).metadata().catch(() => null);
    const pages = meta?.pages && meta.pages > 1 ? meta.pages : 1;
    const w = meta?.width ?? 0, h = meta ? Math.round((meta.pageHeight ?? meta.height / pages)) : 0;
    const scale = w && h ? Math.min(1, DISPLAY_PX / Math.max(w, h)) : 1;
    return { ...full, full: full.url, ...(w && h ? { width: Math.round(w * scale), height: Math.round(h * scale) } : {}) };
  }

  /** A light copy made earlier, if there is one still on disk. */
  private async cachedDisplay(key: string): Promise<Display | null> {
    const base = join(this.cacheDir, `${key}.${CACHE_VERSION}`);
    const cached = await readFile(`${base}.json`, "utf8").then((t) => JSON.parse(t) as Display).catch(() => null);
    return cached && (cached.useOriginal || (await stat(cached.file).catch(() => null))) ? cached : null;
  }

  /** Make (or find in the cache) the WebP display copy and the tiny preview of a picture. */
  private async display(file: string | Buffer, type: string, key: string): Promise<Display> {
    const base = join(this.cacheDir, `${key}.${CACHE_VERSION}`);
    const cached = await readFile(`${base}.json`, "utf8").then((t) => JSON.parse(t) as Display).catch(() => null);
    if (cached && (cached.useOriginal || (await stat(cached.file).catch(() => null)))) return cached;
    const animated = type === "image/gif" || type === "image/webp";
    const img = this.sharp(file, { animated, limitInputPixels: 268402689 });
    const meta = await img.metadata();
    const out = `${base}.webp`;
    const info = await img.clone().resize({ width: DISPLAY_PX, height: DISPLAY_PX, fit: "inside", withoutEnlargement: true }).webp(WEBP).toFile(out);
    const preview = await this.sharp(file).resize(24, 24, { fit: "inside" }).webp({ quality: 40 }).toBuffer();
    const size = typeof file === "string" ? (await stat(file)).size : file.length;
    const d: Display = {
      file: out,
      // a picture already small and light is sent as it is
      useOriginal: info.size >= size * 0.9,
      placeholder: `data:image/webp;base64,${preview.toString("base64")}`,
      width: info.width,
      height: animated && meta.pages && meta.pages > 1 ? Math.round(info.height / meta.pages) : info.height,
    };
    await writeFile(`${base}.json`, JSON.stringify(d));
    return d;
  }

  /**
   * A picture that arrived as data, such as one an agent opened with its Read tool: written to the
   * cache by its contents and sent like any other, instead of as a long string over the socket.
   */
  async fromData(dataUrl: string, waitMs = 0): Promise<MediaResult> {
    const m = /^data:(image\/[\w.+-]+);base64,(.+)$/s.exec(dataUrl);
    if (!m) return { error: "not a picture" };
    const bytes = Buffer.from(m[2], "base64");
    const key = createHash("sha1").update(bytes).digest("hex");
    const file = join(this.cacheDir, `${key}.orig${extFor(m[1]) || ".img"}`);
    if (!(await stat(file).catch(() => null))) await writeFile(file, bytes);
    return this.picture(file, m[1], key, waitMs);
  }

  /** A file in an agent's folder, or anywhere on this machine by absolute path or ~. */
  async local(baseDir: string, path: string, waitMs = 0): Promise<MediaResult> {
    const clean = decodeURI(path.replace(/^file:\/\//, ""));
    const file = resolve(baseDir, clean.replace(/^~(?=$|\/)/, homedir()));
    const t = TYPES[extname(file).toLowerCase()];
    if (!t) return { error: `${extname(file) || "that file"} is not a picture or video the canvas can show` };
    const s = await stat(file).catch(() => null);
    if (!s?.isFile()) return { error: "no such file" };
    if (s.size > MAX_BYTES) return { error: "the file is too large to show" };
    if (t[0] === "image") return this.picture(file, t[1], await this.keyOf(file), waitMs);
    return this.issue(file, t[1], t[0], await this.keyOf(file));
  }

  /** Something on the web. A page is followed once, to the image or video it advertises. */
  /**
   * `proxy`: fetch the file here and serve it, for when the page could not load it from the site
   * itself. Otherwise a link that resolves to a media file is handed back as it is, for the browser
   * to load straight from the site — no waiting for the server to download all of it first.
   */
  async remote(url: string, waitMs = 0, { proxy = false } = {}): Promise<MediaResult> {
    const ck = `${proxy ? "proxy|" : ""}${url}`;
    const cached = this.byKey.get(ck);
    if (cached && !("error" in cached)) return cached;
    this.waitMs = waitMs;
    this.proxy = proxy;
    const result = await this.fetchMedia(url, 1).catch((e: Error) => ({ error: e.name === "TimeoutError" ? "the site took too long" : e.message }));
    this.byKey.set(ck, result);
    return result;
  }

  private async fetchMedia(url: string, hops: number): Promise<MediaResult> {
    if (!/^https?:\/\//i.test(url)) return { error: "only web links and files can be shown" };
    const known = knownMedia(url);
    if (known && known !== url) return this.fetchMedia(known, hops);
    // a link that is plainly a media file: the browser can load it itself, straight away
    const ext = TYPES[extname(new URL(url).pathname).toLowerCase()];
    if (ext && !this.proxy && ext[1] !== "image/svg+xml") return { url, kind: ext[0], mime: ext[1], direct: true };
    const res = await fetch(url, {
      redirect: "follow",
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      headers: { "user-agent": UA, accept: "image/*,video/*,text/html;q=0.8,*/*;q=0.5" },
    });
    if (!res.ok) return { error: `the site answered ${res.status}` };
    const type = (res.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    const kind = kindOf(type) ?? (TYPES[extname(new URL(res.url).pathname).toLowerCase()]?.[0] ?? null);
    if (kind) {
      const len = Number(res.headers.get("content-length") ?? 0);
      if (len > MAX_BYTES) return { error: "it is too large to show" };
      await mkdir(this.dir, { recursive: true });
      const realType = kindOf(type) ? type : TYPES[extname(new URL(res.url).pathname).toLowerCase()][1];
      const file = join(this.dir, `${randomBytes(8).toString("hex")}${extFor(realType)}`);
      let seen = 0;
      const body = Readable.fromWeb(res.body as any);
      body.on("data", (c: Buffer) => { seen += c.length; if (seen > MAX_BYTES) body.destroy(new Error("it is too large to show")); });
      try { await pipeline(body, createWriteStream(file)); } catch (e) { await unlink(file).catch(() => {}); throw e; }
      if (kind === "image") return this.picture(file, realType, await this.keyOf(file), this.waitMs);
      return this.issue(file, realType, kind);
    }
    if (type === "text/html" && hops > 0) {
      // a page about the picture: use the image or video it tells link previews to show
      const html = (await res.text()).slice(0, 2_000_000);
      const found = pageMedia(html, res.url) ?? idMedia(html, res.url);
      if (found) return this.fetchMedia(found, hops - 1);
      return { error: "that link is a web page with no picture or video in it" };
    }
    return { error: `that link is ${type || "not a picture or video"}` };
  }

  /** Serve /media/<token>, with range requests so a video can seek. False when it is not ours. */
  async serve(req: any, res: any, token: string): Promise<boolean> {
    const m = this.tokens.get(token);
    if (!m) return false;
    const s = await stat(m.file).catch(() => null);
    if (!s) return false;
    // a link made from what the picture is never points at anything else: the browser may keep it
    const headers = { "content-type": m.type, "accept-ranges": "bytes", "cache-control": m.lasting ? "private, max-age=2592000, immutable" : "private, max-age=3600", "x-content-type-options": "nosniff",
      // an SVG is shown as a picture, never run as a page
      ...(m.type === "image/svg+xml" ? { "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'" } : {}) };
    const range = /^bytes=(\d*)-(\d*)$/.exec(String(req.headers.range ?? ""));
    if (range && (range[1] || range[2])) {
      let start = range[1] ? Number(range[1]) : Math.max(0, s.size - Number(range[2]));
      let end = range[1] && range[2] ? Number(range[2]) : s.size - 1;
      end = Math.min(end, s.size - 1);
      if (start > end) { res.writeHead(416, { "content-range": `bytes */${s.size}` }).end(); return true; }
      res.writeHead(206, { ...headers, "content-range": `bytes ${start}-${end}/${s.size}`, "content-length": end - start + 1 });
      createReadStream(m.file, { start, end }).pipe(res);
      return true;
    }
    res.writeHead(200, { ...headers, "content-length": s.size });
    createReadStream(m.file).pipe(res);
    return true;
  }
}

/**
 * Sites whose page links map straight to the media file. Giphy draws its pages in the browser,
 * so the page itself has nothing to follow: "giphy.com/gifs/funny-cat-JIX9t2j0ZTN9S" is the GIF
 * at media.giphy.com/media/JIX9t2j0ZTN9S/giphy.gif.
 */
export function knownMedia(url: string): string | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  const host = u.hostname.replace(/^www\./, "");
  if (host === "giphy.com") {
    const id = /^\/(?:gifs|stickers|embed)\/(?:[\w-]*-)?([A-Za-z0-9]{8,})\/?$/.exec(u.pathname)?.[1];
    if (id) return `https://media.giphy.com/media/${id}/giphy.gif`;
  }
  if (host === "imgur.com" && /^\/[A-Za-z0-9]{5,8}$/.test(u.pathname)) return `https://i.imgur.com${u.pathname}.gif`;
  return null;
}

/**
 * The last resort for a page drawn in the browser: a GIF or video link in its source that carries
 * the page's own id (the last word of its path), preferring a video, then a GIF, then the longest.
 */
export function idMedia(html: string, base: string): string | null {
  let id = "";
  try { id = new URL(base).pathname.split(/[/-]/).filter(Boolean).pop() ?? ""; } catch {}
  if (id.length < 5) return null;
  const urls = [...new Set(html.match(/https?:\/\/[^"'\s\\<>]+?\.(?:mp4|webm|gif|webp)(?=["'\s\\<>?])/gi) ?? [])].filter((u) => u.includes(id));
  if (!urls.length) return null;
  const rank = (u: string) => (/\.(mp4|webm)$/i.test(u) ? 2 : /\.gif$/i.test(u) ? 1 : 0) * 1000 + u.length;
  return urls.sort((a, b) => rank(b) - rank(a))[0];
}

/** The image or video a page advertises for link previews: og:video first, then og:image. */
export function pageMedia(html: string, base: string): string | null {
  const meta = (prop: string) => {
    const re = new RegExp(`<meta[^>]+(?:property|name)=["']${prop}["'][^>]*>`, "i");
    const tag = re.exec(html)?.[0];
    const content = tag && /content=["']([^"']+)["']/i.exec(tag)?.[1];
    return content ? content.replace(/&amp;/g, "&") : null;
  };
  const found = meta("og:video:secure_url") ?? meta("og:video:url") ?? meta("og:video") ?? meta("og:image:secure_url") ?? meta("og:image") ?? meta("twitter:image") ?? meta("twitter:image:src");
  if (!found) return null;
  try { return new URL(found, base).href; } catch { return null; }
}

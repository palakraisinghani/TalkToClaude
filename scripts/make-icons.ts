// Makes the app's PNG icons from web/icon.svg. Run: node scripts/make-icons.ts
//
// Phones and tablets want PNGs at fixed sizes: iOS for the home screen (it ignores SVG), Android and
// desktop browsers for an installed app. The "maskable" one fills the whole square, because Android
// crops icons to its own shape and the plain one's rounded corners would show as a ring.
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import sharp from "sharp";

const web = join(import.meta.dirname, "..", "web");
const svg = await readFile(join(web, "icon.svg"), "utf8");
// full bleed: the background square runs to the edges, and the artwork on it shrinks into the safe
// zone. Everything after the background square is the artwork, whatever the logo is.
const BG = '<rect x="2" y="2" width="60" height="60" rx="15" fill="url(#bg)"/>';
if (!svg.includes(BG)) throw new Error("icon.svg: expected the background square as " + BG);
const art = (scale: number, background: boolean) => svg
  .replace(BG, `${background ? '<rect x="0" y="0" width="64" height="64" fill="url(#bg)"/>' : ""}<g transform="translate(32 32) scale(${scale}) translate(-32 -32)">`)
  .replace("</svg>", "</g></svg>");
const bleed = art(0.86, true);
const out = async (src: string, size: number, name: string) => {
  await sharp(Buffer.from(src), { density: 72 * (size / 64) * 2 }).resize(size, size).png().toFile(join(web, name));
  console.log(name);
};
await out(svg, 192, "icon-192.png");
await out(svg, 512, "icon-512.png");
// iOS puts its own rounded corners and no transparency on it: the full-bleed square looks right
await out(bleed, 180, "apple-touch-icon.png");
await out(bleed, 512, "icon-maskable.png");

// Android's adaptive icon: the artwork alone on a transparent square, inside the middle two thirds
// it keeps whatever shape it crops to; the orange behind it is the icon's background colour
const foreground = art(0.66, false);
await sharp(Buffer.from(foreground), { density: 72 * (432 / 64) * 2 }).resize(432, 432).png()
  .toFile(join(import.meta.dirname, "..", "android", "app", "src", "main", "res", "mipmap-xxxhdpi", "ic_launcher_foreground.png"));
console.log("android ic_launcher_foreground.png");

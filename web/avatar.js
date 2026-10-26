// Each agent's face: a small illustrated character drawn on its colour, the same every time for
// the same name. Head shape, eyes, mouth and an accessory are picked from the name, so the team
// tells apart at a glance; the assistant always wears a headset. Plain SVG strings, so the same
// face can be a 20px chip or the big orb, and the orb can move its mouth while it talks.

const hash = (s) => { let h = 2166136261; for (const c of String(s)) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; };

const INK = "#2b2a28";

function head(kind, face, rim) {
  switch (kind) {
    case "robot":
      return `<rect x="15" y="19" width="34" height="31" rx="10" fill="${face}" stroke="${rim}" stroke-width="1.5"/><rect x="11" y="31" width="4" height="9" rx="2" fill="${rim}"/><rect x="49" y="31" width="4" height="9" rx="2" fill="${rim}"/>`;
    case "cat":
      return `<path d="M17 27 L19 13 L28 21 Z M47 27 L45 13 L36 21 Z" fill="${face}" stroke="${rim}" stroke-width="1.5" stroke-linejoin="round"/><circle cx="32" cy="35" r="17" fill="${face}" stroke="${rim}" stroke-width="1.5"/>`;
    case "ghost":
      return `<path d="M15 50 V33 a17 17 0 0 1 34 0 V50 l-5.7 -3.5 -5.6 3.5 -5.7 -3.5 -5.7 3.5 -5.6 -3.5 Z" fill="${face}" stroke="${rim}" stroke-width="1.5" stroke-linejoin="round"/>`;
    default:
      return `<circle cx="32" cy="35" r="17" fill="${face}" stroke="${rim}" stroke-width="1.5"/>`;
  }
}

/** Eyes shut mid-blink: a short line where each eye is, never an empty face. */
function shut(kind) {
  const y = kind === "happy" ? 33 : kind === "visor" ? 33.5 : 33;
  return `<path d="M22.5 ${y} h6 M35.5 ${y} h6" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`;
}

function eyes(kind) {
  switch (kind) {
    case "happy":
      return `<path d="M22.5 34 q3 -4 6 0 M35.5 34 q3 -4 6 0" fill="none" stroke="${INK}" stroke-width="2.2" stroke-linecap="round"/>`;
    case "visor":
      return `<rect x="20" y="29" width="24" height="9" rx="4.5" fill="${INK}"/><circle cx="26" cy="33.5" r="2" fill="#7fe3ff"/><circle cx="38" cy="33.5" r="2" fill="#7fe3ff"/>`;
    case "big":
      return `<ellipse cx="25.5" cy="33" rx="3.6" ry="4.4" fill="${INK}"/><ellipse cx="38.5" cy="33" rx="3.6" ry="4.4" fill="${INK}"/><circle cx="26.8" cy="31.4" r="1.3" fill="#fff"/><circle cx="39.8" cy="31.4" r="1.3" fill="#fff"/>`;
    default:
      return `<circle cx="25.5" cy="33" r="2.6" fill="${INK}"/><circle cx="38.5" cy="33" r="2.6" fill="${INK}"/>`;
  }
}

function mouth(kind) {
  switch (kind) {
    case "open":
      return `<path class="mouth" d="M28.5 41 q3.5 4.5 7 0 Z" fill="${INK}"/>`;
    case "cat":
      return `<path class="mouth" d="M28 41 q2 2 4 0 q2 2 4 0" fill="none" stroke="${INK}" stroke-width="1.8" stroke-linecap="round"/>`;
    default:
      return `<path class="mouth" d="M27.5 40.5 q4.5 4 9 0" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/>`;
  }
}

function accessory(kind, hue) {
  const deep = `hsl(${hue} 55% 38%)`;
  switch (kind) {
    case "headset":
      return `<path d="M13.5 35 a18.5 18.5 0 0 1 37 0" fill="none" stroke="${INK}" stroke-width="3" stroke-linecap="round"/><rect x="10" y="31" width="7" height="11" rx="3.5" fill="${INK}"/><rect x="47" y="31" width="7" height="11" rx="3.5" fill="${INK}"/><path d="M13.5 41 q1 8 11 8.5" fill="none" stroke="${INK}" stroke-width="2" stroke-linecap="round"/><circle cx="26" cy="49.5" r="2.4" fill="${INK}"/>`;
    case "antenna":
      return `<path d="M32 19 V10" stroke="${INK}" stroke-width="2" stroke-linecap="round"/><circle cx="32" cy="8.5" r="3.2" fill="hsl(${(hue + 180) % 360} 80% 60%)" stroke="${INK}" stroke-width="1.2"/>`;
    case "sprout":
      return `<path d="M32 19 V12" stroke="#3f8f3a" stroke-width="2" stroke-linecap="round"/><path d="M32 13 q-7 -1 -8 -7 q7 0 8 7 Z M32 13 q6 -2 8 -7 q-7 0 -8 7 Z" fill="#5cb85c"/>`;
    case "beanie":
      return `<path d="M15.5 30 a16.5 14 0 0 1 33 0 Z" fill="${deep}"/><rect x="14" y="27.5" width="36" height="5" rx="2.5" fill="hsl(${hue} 50% 30%)"/><circle cx="32" cy="15" r="3.2" fill="hsl(${hue} 50% 30%)"/>`;
    case "bow":
      return `<path d="M40 19 l-6 -4 v8 Z M40 19 l6 -4 v8 Z" fill="hsl(${(hue + 150) % 360} 75% 62%)" stroke="${INK}" stroke-width="1" stroke-linejoin="round"/><circle cx="40" cy="19" r="1.8" fill="${INK}"/>`;
    default:
      return "";
  }
}

const HEADS = ["round", "robot", "cat", "ghost"];
const EYES = ["dots", "big", "happy", "visor"];
const MOUTHS = ["smile", "open", "cat", "smile"];
const EXTRAS = ["antenna", "sprout", "beanie", "bow", ""];

/** A character for this agent, on a transparent ground: its colour comes from the circle behind. */
export function avatar(name, hue = 18, { central = false } = {}) {
  const n = String(name).toLowerCase();
  // each feature from its own hash, so they vary independently of one another
  const pick = (list, salt) => list[hash(`${n}|${salt}`) % list.length];
  const h = hash(n);
  const shape = central ? "round" : pick(HEADS, "head");
  let eye = central ? "big" : pick(EYES, "eyes");
  if (eye === "visor" && shape !== "robot") eye = pick(["dots", "big", "happy"], "eyes2"); // a visor only suits a robot
  const extra = central ? "headset" : shape === "robot" ? "antenna" : shape === "cat" ? pick(["bow", "", "sprout"], "extra") : pick(EXTRAS, "extra");
  const face = `hsl(${hue} 70% 95%)`;
  const rim = `hsl(${hue} 45% 32% / .35)`;
  // the face is drawn smaller than the circle, so the colour around it still says who this is
  return `<svg class="avatar" viewBox="0 0 64 64" aria-hidden="true">`
    + (extra === "beanie" ? "" : accessory(extra === "headset" ? "" : extra, hue))
    + head(shape, face, rim)
    // open and shut both drawn; a blink swaps them for a moment (index.html, .avatar .eyes)
    + `<g class="eyes" style="--blink:-${(h % 50) / 10}s"><g class="open">${eyes(eye)}</g><g class="shut">${shut(eye)}</g></g>`
    + `<circle cx="20.5" cy="39.5" r="2.6" fill="hsl(350 85% 72% / .55)"/><circle cx="43.5" cy="39.5" r="2.6" fill="hsl(350 85% 72% / .55)"/>`
    + mouth(central ? "smile" : shape === "cat" ? "cat" : pick(MOUTHS, "mouth"))
    + (extra === "beanie" || extra === "headset" ? accessory(extra, hue) : "")
    + `</svg>`;
}

// The four sections of the screen — team, call, canvas, behind the scenes — as a deck you arrange:
// drag the divider between two to resize them, collapse any of them to a slim rail, and move them
// around (◂ ▸, or drag one by its grip onto another). The arrangement is remembered. Used on wide
// screens; tablets and phones keep their own layouts (index.html).
//
// Sizes are weights: each open section takes a share of the width in proportion to its weight,
// collapsed ones a fixed rail. Dragging a divider moves width from one neighbour to the other.

export const SECTIONS = ["head", "room", "canvas", "feed"];
const DEFAULT = { order: [...SECTIONS], weight: { head: 272, room: 520, canvas: 640, feed: 380 }, collapsed: {} };
const MIN = { head: 250, room: 320, canvas: 300, feed: 240 };
export const RAIL = 34;
const KEY = "deckLayout";

/** A layout from storage, made whole: unknown or missing parts take the defaults. */
export function normalise(saved) {
  const order = Array.isArray(saved?.order) && saved.order.length === SECTIONS.length && SECTIONS.every((s) => saved.order.includes(s)) ? [...saved.order] : [...DEFAULT.order];
  const weight = { ...DEFAULT.weight };
  for (const s of SECTIONS) if (Number.isFinite(saved?.weight?.[s]) && saved.weight[s] > 0) weight[s] = saved.weight[s];
  const collapsed = {};
  for (const s of SECTIONS) if (saved?.collapsed?.[s]) collapsed[s] = true;
  return { order, weight, collapsed };
}

/** Move a section one place left (-1) or right (+1). */
export function move(layout, id, dir) {
  const order = [...layout.order];
  const i = order.indexOf(id), j = i + dir;
  if (i < 0 || j < 0 || j >= order.length) return layout;
  [order[i], order[j]] = [order[j], order[i]];
  return { ...layout, order };
}

/** Put `id` where `onto` is (dragged onto it): the two change places. */
export function swap(layout, id, onto) {
  const order = [...layout.order];
  const i = order.indexOf(id), j = order.indexOf(onto);
  if (i < 0 || j < 0 || i === j) return layout;
  [order[i], order[j]] = [order[j], order[i]];
  return { ...layout, order };
}

export function collapse(layout, id, on) {
  const collapsed = { ...layout.collapsed };
  if (on) collapsed[id] = true; else delete collapsed[id];
  // never all of them: something stays open
  if (SECTIONS.every((s) => collapsed[s])) return layout;
  return { ...layout, collapsed };
}

/**
 * Drag the divider between `left` and `right` by `dx` pixels, given their widths now. Width moves
 * from one to the other, never below either's minimum; the others keep their share.
 */
export function resize(layout, left, right, dx, widths) {
  const total = widths[left] + widths[right];
  const l = Math.max(MIN[left], Math.min(total - MIN[right], widths[left] + dx));
  const weight = { ...layout.weight };
  // weights in pixels, so open sections keep the sizes they show now
  for (const s of SECTIONS) if (widths[s] && !layout.collapsed[s]) weight[s] = widths[s];
  weight[left] = l;
  weight[right] = total - l;
  return { ...layout, weight };
}

export function load() {
  try { return normalise(JSON.parse(localStorage.getItem(KEY) || "null")); } catch { return normalise(null); }
}
function save(layout) {
  try { localStorage.setItem(KEY, JSON.stringify(layout)); } catch {}
}

/**
 * Wire it to the page. `sections` maps each id to its element; `labels` to its rail title.
 * Returns { active(), expand(id), fresh(id), reset() }.
 */
export function initDeck({ main, sections, labels, enabled }) {
  let layout = load();
  const gutters = [];
  // a control bar and a rail for each section
  for (const id of SECTIONS) {
    const el = sections[id];
    const bar = Object.assign(document.createElement("div"), { className: "deckbar" });
    bar.innerHTML = `<button type="button" data-a="left" title="Move left">◂</button><span class="grip" draggable="true" title="Drag onto another section to swap them">⠿</span><button type="button" data-a="right" title="Move right">▸</button><button type="button" data-a="fold" title="Collapse">–</button>`;
    bar.addEventListener("click", (e) => {
      const a = e.target.closest("button")?.dataset.a;
      if (a === "left" || a === "right") set(move(layout, id, a === "left" ? -1 : 1));
      if (a === "fold") set(collapse(layout, id, true));
    });
    const grip = bar.querySelector(".grip");
    grip.addEventListener("dragstart", (e) => { e.dataTransfer.setData("text/deck", id); e.dataTransfer.effectAllowed = "move"; document.body.classList.add("deck-dragging"); });
    grip.addEventListener("dragend", () => { document.body.classList.remove("deck-dragging"); for (const s of SECTIONS) sections[s].classList.remove("deck-drop"); });
    el.addEventListener("dragover", (e) => { if (e.dataTransfer.types.includes("text/deck")) { e.preventDefault(); el.classList.add("deck-drop"); } });
    el.addEventListener("dragleave", () => el.classList.remove("deck-drop"));
    el.addEventListener("drop", (e) => {
      const from = e.dataTransfer.getData("text/deck");
      el.classList.remove("deck-drop");
      if (from && from !== id) { e.preventDefault(); set(swap(layout, from, id)); }
    });
    const rail = Object.assign(document.createElement("button"), { type: "button", className: "deckrail", title: `Open ${labels[id]}` });
    rail.innerHTML = `<span class="dot"></span><span class="lbl">${labels[id]}</span>`;
    rail.onclick = () => set(collapse(layout, id, false));
    el.prepend(rail);
    el.prepend(bar);
  }

  function set(next) {
    layout = next;
    save(layout);
    apply();
  }

  function apply() {
    const on = enabled();
    document.body.classList.toggle("deck", on);
    gutters.splice(0).forEach((g) => g.remove());
    if (!on) {
      for (const id of SECTIONS) { const el = sections[id]; el.style.order = el.style.flex = ""; el.classList.remove("deck-collapsed"); }
      return;
    }
    const visible = layout.order.filter((id) => getComputedStyle(sections[id]).display !== "none" || sections[id].classList.contains("deck-collapsed"));
    layout.order.forEach((id, i) => {
      const el = sections[id];
      el.style.order = String(i * 2);
      const folded = !!layout.collapsed[id];
      el.classList.toggle("deck-collapsed", folded);
      el.style.flex = folded ? `0 0 ${RAIL}px` : `${layout.weight[id]} 1 0px`;
      el.style.minWidth = folded ? `${RAIL}px` : `${MIN[id]}px`;
      if (!folded) el.querySelector(":scope > .deckrail .dot")?.classList.remove("on");
    });
    // a divider between each pair of open neighbours
    const open = layout.order.filter((id) => visible.includes(id));
    for (let i = 0; i + 1 < open.length; i++) {
      const left = open[i], right = open[i + 1];
      if (layout.collapsed[left] || layout.collapsed[right]) continue;
      const g = Object.assign(document.createElement("div"), { className: "deckgutter", title: "Drag to resize · double-click to reset" });
      g.style.order = String(layout.order.indexOf(left) * 2 + 1);
      g.addEventListener("pointerdown", (e) => drag(e, g, left, right));
      g.addEventListener("dblclick", () => set({ ...layout, weight: { ...DEFAULT.weight } }));
      main.appendChild(g);
      gutters.push(g);
    }
    window.dispatchEvent(new Event("resize")); // canvases and diagrams re-fit to their new width
  }

  function drag(e, g, left, right) {
    e.preventDefault();
    g.setPointerCapture(e.pointerId);
    document.body.classList.add("deck-resizing");
    const x0 = e.clientX;
    const widths = {};
    for (const s of SECTIONS) widths[s] = sections[s].getBoundingClientRect().width;
    const onMove = (ev) => {
      const next = resize(layout, left, right, ev.clientX - x0, widths);
      layout = next;
      for (const s of [left, right]) sections[s].style.flex = `${layout.weight[s]} 1 0px`;
      for (const s of SECTIONS) if (!layout.collapsed[s] && s !== left && s !== right) sections[s].style.flex = `${layout.weight[s]} 1 0px`;
    };
    const onUp = () => {
      g.removeEventListener("pointermove", onMove);
      g.removeEventListener("pointerup", onUp);
      document.body.classList.remove("deck-resizing");
      save(layout);
      window.dispatchEvent(new Event("resize"));
    };
    g.addEventListener("pointermove", onMove);
    g.addEventListener("pointerup", onUp);
  }

  window.addEventListener("resize", () => { if (enabled() !== document.body.classList.contains("deck")) apply(); });
  apply();
  return {
    active: () => document.body.classList.contains("deck"),
    /** Open a collapsed section: something has arrived that should be seen. */
    expand(id) { if (layout.collapsed[id]) set(collapse(layout, id, false)); },
    /** Something new in a section: a dot on its rail if it is collapsed. */
    fresh(id) { if (layout.collapsed[id]) sections[id].querySelector(":scope > .deckrail .dot")?.classList.add("on"); },
    reset() { set(normalise(null)); },
    refresh: apply,
  };
}

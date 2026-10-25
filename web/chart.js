// Charts and plots an agent draws on the canvas, from a fenced ```chart block of JSON.
//
//   {"type": "bar", "title": "…", "labels": ["a", "b"], "series": [{"name": "…", "data": [1, 2]}]}
//   {"type": "line", "x": [0, 0.5, 1], "series": [{"name": "sin", "data": [0, 0.48, 0.84]}]}
//   {"type": "scatter", "series": [{"name": "runs", "points": [[1.2, 30], [2.4, 41]]}]}
//
// type: bar (grouped, or "stacked": true), hbar (horizontal, for long labels), line, area,
// scatter. Categories come from "labels"; a numeric x axis from "x" or from [x, y] points, so a
// function or a measurement plots at its true spacing. "xLabel" / "yLabel" title the axes.
//
// Built as plain SVG strings so the markdown renderer can use it anywhere, including in tests.
// The look follows fixed rules: one shared scale (never two y axes), categorical colours in a
// fixed order that follows the series not its rank, bars at most 24px with a rounded data end
// and a square baseline, 2px lines, 8px dots with a ring, a legend whenever there are two or
// more series, a recessive grid, a native tooltip on every mark, and the numbers as a table.

import { esc } from "./markdown.js";

const W = 640, H = 320;
const MAX_SERIES = 8;
const TYPES = ["bar", "hbar", "line", "area", "scatter"];

/** Round tick steps (1, 2, 2.5, 5 × 10^n) covering min..max in about `count` steps. */
export function ticks(min, max, count = 5) {
  if (!Number.isFinite(min) || !Number.isFinite(max)) return [0, 1];
  if (min === max) { const d = Math.abs(min) || 1; min -= d / 2; max += d / 2; }
  const raw = (max - min) / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? 10 * mag;
  const lo = Math.floor(min / step + 1e-9) * step, hi = Math.ceil(max / step - 1e-9) * step;
  const out = [];
  for (let v = lo; v <= hi + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
}

export const fmt = (v) => {
  const a = Math.abs(v);
  if (a >= 1e9) return `${+(v / 1e9).toFixed(1)}B`;
  if (a >= 1e6) return `${+(v / 1e6).toFixed(1)}M`;
  if (a >= 1e4) return `${+(v / 1e3).toFixed(1)}k`;
  if (a > 0 && a < 0.01) return v.toExponential(1);
  return String(+v.toFixed(2));
};

const num = (v) => { const n = Number(v); return v !== null && v !== "" && Number.isFinite(n) ? n : null; };
const clip = (s, n) => (s.length > n ? s.slice(0, n - 1) + "…" : s);

/** A bar along `dir` ("v" or "h") with a 4px rounded end away from the baseline. */
function barPath(dir, base, end, a, w) {
  const len = Math.abs(end - base);
  if (len < 0.5) return "";
  const r = Math.min(4, w / 2, len);
  if (dir === "v") {
    const up = end < base, y1 = end, x = a;
    return up
      ? `M${x},${base}V${y1 + r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 + r}V${base}Z`
      : `M${x},${base}V${y1 - r}Q${x},${y1} ${x + r},${y1}H${x + w - r}Q${x + w},${y1} ${x + w},${y1 - r}V${base}Z`;
  }
  const right = end > base, x1 = end, y = a;
  return right
    ? `M${base},${y}H${x1 - r}Q${x1},${y} ${x1},${y + r}V${y + w - r}Q${x1},${y + w} ${x1 - r},${y + w}H${base}Z`
    : `M${base},${y}H${x1 + r}Q${x1},${y} ${x1},${y + r}V${y + w - r}Q${x1},${y + w} ${x1 + r},${y + w}H${base}Z`;
}

/** Check and tidy a spec; returns { error } instead when it cannot be drawn (yet). */
export function parseChart(src) {
  let spec;
  try { spec = JSON.parse(src); } catch { return { error: "drawing…" }; }
  if (!spec || typeof spec !== "object") return { error: "A chart needs a JSON object." };
  let type = String(spec.type ?? "bar").toLowerCase();
  if (type === "column") type = "bar";
  if (type === "pie" || type === "donut") type = "hbar"; // parts of a whole read better as bars
  if (!TYPES.includes(type)) type = "bar";
  const raw = Array.isArray(spec.series) ? spec.series : Array.isArray(spec.data) ? [{ name: spec.title ?? "", data: spec.data }] : [];
  // numeric x: from "x", or when the data are [x, y] pairs or {x, y} points
  const pair = (d) => (Array.isArray(d) ? [num(d[0]), num(d[1])] : d && typeof d === "object" ? [num(d.x), num(d.y)] : null);
  const hasPairs = raw.some((s) => (s?.points ?? s?.data ?? []).some((d) => Array.isArray(d) || (d && typeof d === "object")));
  const xs = Array.isArray(spec.x) ? spec.x.map(num) : null;
  const numeric = type === "scatter" || hasPairs || (!!xs && xs.every((v) => v !== null) && (type === "line" || type === "area"));
  const series = raw.slice(0, MAX_SERIES).map((s, i) => {
    const name = String(s?.name ?? (raw.length > 1 ? `Series ${i + 1}` : ""));
    const data = s?.points ?? s?.data ?? [];
    if (numeric) {
      const pts = hasPairs ? data.map(pair) : data.map((y, j) => [xs?.[j] ?? j, num(y)]);
      return { name, points: pts.filter((p) => p && p[0] !== null && p[1] !== null).map(([x, y]) => ({ x, y })) };
    }
    return { name, data: data.map(num) };
  });
  const labels = numeric ? [] : (Array.isArray(spec.labels) ? spec.labels.map(String) : series[0]?.data.map((_, i) => String(i + 1)) ?? []);
  if (!numeric) for (const s of series) s.data = labels.map((_, j) => s.data[j] ?? null);
  const empty = numeric ? !series.some((s) => s.points.length) : !labels.length;
  if (!series.length || empty) return { error: "A chart needs at least one series with values." };
  return {
    type: numeric && (type === "bar" || type === "hbar") ? "line" : type,
    numeric, labels, series,
    stacked: !!spec.stacked && (type === "bar" || type === "hbar"),
    title: spec.title ? String(spec.title) : "",
    xLabel: spec.xLabel ? String(spec.xLabel) : "", yLabel: spec.yLabel ? String(spec.yLabel) : "",
  };
}

export function renderChart(src) {
  const c = parseChart(src);
  if (c.error) return `<div class="chart pending">${esc(c.error)}</div>`;
  const { type, numeric, labels, series, stacked, title, xLabel, yLabel } = c;
  const horizontal = type === "hbar";
  const parts = [];

  // the value scale: stacked bars stack their totals; bars and areas always include zero
  let values = numeric ? series.flatMap((s) => s.points.map((p) => p.y)) : series.flatMap((s) => s.data).filter((v) => v !== null);
  if (stacked) values = labels.flatMap((_, i) => [series.reduce((a, s) => a + Math.max(0, s.data[i] ?? 0), 0), series.reduce((a, s) => a + Math.min(0, s.data[i] ?? 0), 0)]);
  const zero = type === "bar" || type === "hbar" || type === "area";
  const vScale = ticks(Math.min(zero ? 0 : Infinity, ...values), Math.max(zero ? 0 : -Infinity, ...values));
  const vlo = vScale[0], vhi = vScale[vScale.length - 1];

  // room for the axis labels, measured roughly from the longest of them
  const vTickText = vScale.map(fmt);
  const longestCat = Math.max(0, ...labels.map((l) => clip(l, 18).length));
  const left = horizontal ? Math.min(140, 14 + longestCat * 6.6) : Math.max(36, 12 + Math.max(...vTickText.map((t) => t.length)) * 6.6) + (yLabel ? 16 : 0);
  const pad = { top: 14, right: 22 + (series.length > 1 && series.length <= 4 && (type === "line" || type === "area") ? 54 : 0), bottom: 30 + (xLabel ? 18 : 0), left };
  const pw = W - pad.left - pad.right, ph = H - pad.top - pad.bottom;

  // value axis position: vertical for most, horizontal for hbar
  const vPos = horizontal ? (v) => pad.left + ((v - vlo) / (vhi - vlo)) * pw : (v) => pad.top + ph - ((v - vlo) / (vhi - vlo)) * ph;

  // the other axis: categories in bands, or a numeric scale
  let xPos, xTicks = [];
  const band = (horizontal ? ph : pw) / Math.max(1, labels.length);
  if (numeric) {
    const allX = series.flatMap((s) => s.points.map((p) => p.x));
    xTicks = ticks(Math.min(...allX), Math.max(...allX), 6);
    const xlo = xTicks[0], xhi = xTicks[xTicks.length - 1];
    xPos = (x) => pad.left + ((x - xlo) / (xhi - xlo)) * pw;
  } else xPos = (i) => (horizontal ? pad.top : pad.left) + band * (i + 0.5);

  // grid and value ticks
  for (const t of vScale) {
    const p = vPos(t);
    parts.push(horizontal
      ? `<line class="grid${t === 0 ? " zero" : ""}" x1="${p}" x2="${p}" y1="${pad.top}" y2="${pad.top + ph}"/><text class="tick" x="${p}" y="${H - pad.bottom + 18}" text-anchor="middle">${esc(fmt(t))}</text>`
      : `<line class="grid${t === 0 ? " zero" : ""}" x1="${pad.left}" x2="${W - pad.right}" y1="${p}" y2="${p}"/><text class="tick" x="${pad.left - 8}" y="${p + 4}" text-anchor="end">${esc(fmt(t))}</text>`);
  }
  if (numeric) {
    for (const t of xTicks) parts.push(`<line class="grid faint" x1="${xPos(t)}" x2="${xPos(t)}" y1="${pad.top}" y2="${pad.top + ph}"/><text class="tick" x="${xPos(t)}" y="${H - pad.bottom + 18}" text-anchor="middle">${esc(fmt(t))}</text>`);
  } else {
    const room = horizontal ? 16 : 64;
    const every = Math.ceil(labels.length / Math.max(1, Math.floor((horizontal ? ph : pw) / room)));
    labels.forEach((l, i) => {
      if (i % every) return;
      parts.push(horizontal
        ? `<text class="tick" x="${pad.left - 8}" y="${xPos(i) + 4}" text-anchor="end">${esc(clip(l, 18))}</text>`
        : `<text class="tick" x="${xPos(i)}" y="${H - pad.bottom + 18}" text-anchor="middle">${esc(clip(l, 12))}</text>`);
    });
  }
  if (xLabel) parts.push(`<text class="axis" x="${pad.left + pw / 2}" y="${H - 6}" text-anchor="middle">${esc(xLabel)}</text>`);
  if (yLabel) parts.push(`<text class="axis" transform="translate(12 ${pad.top + ph / 2}) rotate(-90)" text-anchor="middle">${esc(yLabel)}</text>`);

  const tip = (i) => esc(`${labels[i]}\n${series.map((s) => `${s.name || "value"}: ${s.data[i] ?? "—"}`).join("\n")}`);
  const named = (s, rest) => esc(s.name ? `${s.name} · ${rest}` : rest);

  if (type === "bar" || type === "hbar") {
    const dir = horizontal ? "h" : "v";
    const groups = stacked ? 1 : series.length;
    const w = Math.max(3, Math.min(24, (band * 0.72 - 2 * (groups - 1)) / groups));
    const group = w * groups + 2 * (groups - 1);
    labels.forEach((_, i) => {
      let up = 0, down = 0;
      series.forEach((s, k) => {
        const v = s.data[i];
        if (v === null) return;
        const a = xPos(i) - group / 2 + (stacked ? 0 : k * (w + 2));
        let from = 0, to = v;
        if (stacked) { if (v >= 0) { from = up; up += v; to = up; } else { from = down; down += v; to = down; } }
        // touching stacked segments keep a 2px gap in the surface colour
        const gap = stacked && from !== 0 ? (horizontal ? (v >= 0 ? 1 : -1) : (v >= 0 ? -1 : 1)) : 0;
        parts.push(`<path class="mark s${k + 1}" d="${barPath(dir, vPos(from) + gap, vPos(to), a, w)}"><title>${named(s, `${labels[i]}: ${v}`)}</title></path>`);
      });
      parts.push(horizontal
        ? `<rect class="hit" x="${pad.left}" y="${xPos(i) - band / 2}" width="${pw}" height="${band}"><title>${tip(i)}</title></rect>`
        : `<rect class="hit" x="${xPos(i) - band / 2}" y="${pad.top}" width="${band}" height="${ph}"><title>${tip(i)}</title></rect>`);
    });
  } else {
    const ends = [];
    series.forEach((s, k) => {
      const pts = numeric
        ? s.points.map((p) => ({ x: xPos(p.x), y: vPos(p.y), label: `${fmt(p.x)}, ${fmt(p.y)}` }))
        : s.data.map((v, i) => (v === null ? null : { x: xPos(i), y: vPos(v), label: `${labels[i]}: ${v}` }));
      if (type !== "scatter") {
        const sorted = numeric ? [...pts].sort((a, b) => a.x - b.x) : pts;
        // a gap in the data is a gap in the line
        let d = "", prev = null;
        for (const p of sorted) { if (p) d += `${prev ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`; prev = p; }
        if (type === "area") {
          const run = sorted.filter(Boolean);
          if (run.length > 1) parts.push(`<path class="fill s${k + 1}" d="M${run[0].x},${vPos(0)}${run.map((p) => `L${p.x.toFixed(1)},${p.y.toFixed(1)}`).join("")}L${run[run.length - 1].x},${vPos(0)}Z"/>`);
        }
        parts.push(`<path class="line s${k + 1}" d="${d}"/>`);
      }
      const dots = pts.filter(Boolean);
      if (type === "scatter" || dots.length <= 40) dots.forEach((p) => parts.push(`<circle class="dot s${k + 1}" cx="${p.x.toFixed(1)}" cy="${p.y.toFixed(1)}" r="${type === "scatter" ? 4.5 : 3.5}"><title>${named(s, p.label)}</title></circle>`));
      // a direct label at the end of each line, when there are few enough to place apart
      const last = (numeric ? [...dots].sort((a, b) => a.x - b.x) : dots).at(-1);
      if (type !== "scatter" && series.length > 1 && series.length <= 4 && last && s.name) ends.push({ x: last.x + 8, y: last.y + 4, text: clip(s.name, 9) });
    });
    // lines that end close together would print their names on top of each other: spread them
    ends.sort((a, b) => a.y - b.y);
    for (let i = 1; i < ends.length; i++) ends[i].y = Math.max(ends[i].y, ends[i - 1].y + 13);
    for (const e of ends) parts.push(`<text class="direct" x="${e.x}" y="${e.y.toFixed(1)}">${esc(e.text)}</text>`);
    if (!numeric) labels.forEach((_, i) => parts.push(`<rect class="hit" x="${xPos(i) - band / 2}" y="${pad.top}" width="${band}" height="${ph}"><title>${tip(i)}</title></rect>`));
  }

  const legend = series.length > 1
    ? `<div class="legend">${series.map((s, k) => `<span><i class="s${k + 1}${type === "scatter" || type === "line" ? " round" : ""}"></i>${esc(s.name)}</span>`).join("")}</div>`
    : "";
  const rows = numeric
    ? series.flatMap((s) => s.points.map((p) => `<tr>${series.length > 1 ? `<td>${esc(s.name)}</td>` : ""}<td>${p.x}</td><td>${p.y}</td></tr>`))
    : labels.map((l, i) => `<tr><td>${esc(l)}</td>${series.map((s) => `<td>${s.data[i] ?? "—"}</td>`).join("")}</tr>`);
  const head = numeric
    ? `${series.length > 1 ? "<th>series</th>" : ""}<th>${esc(xLabel || "x")}</th><th>${esc(yLabel || "y")}</th>`
    : `<th></th>${series.map((s) => `<th>${esc(s.name || "value")}</th>`).join("")}`;
  const table = `<details class="data"><summary>Data table</summary><div class="tbl"><table><thead><tr>${head}</tr></thead><tbody>${rows.slice(0, 500).join("")}</tbody></table></div></details>`;
  return `<figure class="chart">${title ? `<figcaption>${esc(title)}</figcaption>` : ""}${legend}<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(title || `${type} chart`)}">${parts.join("")}</svg>${table}</figure>`;
}

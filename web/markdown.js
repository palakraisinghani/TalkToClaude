// Small markdown renderer for the behind-the-scenes panel. Safe to call on a half-streamed
// document: an unclosed ``` fence renders as code so far, and whitespace inside code is kept
// exactly (indentation, blank lines, long lines scroll instead of wrapping).

import { renderChart } from "./chart.js";

const MEDIA_URL = String.raw`https?:\/\/[^\s)<]*?(?:\.(?:gif|png|jpe?g|webp|svg|avif|mp4|m4v|webm|mov)(?:\?[^\s)<]*)?|youtube\.com\/(?:watch\?[^\s)<]*v=|shorts\/)[\w-]{11}[^\s)<]*|youtu\.be\/[\w-]{11}[^\s)<]*)`;
const MEDIA_LINK = new RegExp(String.raw`(?<!!)\[([^\]\n]+)\]\((${MEDIA_URL})\)`, "g");
const BARE_MEDIA = new RegExp(String.raw`(^|\s)(${MEDIA_URL})(?=\s|$)`, "g");

export const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

// a line that is only a path to a picture or video ("output/plot.png", in backticks or not) shows it
const LONE_PATH = /^\s*`?((?:~|\.{1,2})?\/?[\w.\-~/]+\.(?:png|jpe?g|gif|webp|svg|avif|mp4|m4v|webm|mov))`?\s*$/i;

function inline(s) {
  const lone = LONE_PATH.exec(s);
  if (lone) return `<span class="media" data-alt="" data-src="${esc(lone[1])}"></span>`;
  // protect code spans first so their contents are not formatted
  const spans = [];
  let t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${spans.push(c) - 1}\u0000`);
  t = t
    // pictures, GIFs and videos are filled in by the page, which fetches them over the socket:
    // ![alt](src), a link straight to a media file or a YouTube video, or such a link on its own
    .replace(/!\[([^\]\n]*)\]\(([^)\s]+)\)/g, '<span class="media" data-alt="$1" data-src="$2"></span>')
    .replace(MEDIA_LINK, '<span class="media" data-alt="$1" data-src="$2"></span>')
    .replace(BARE_MEDIA, '$1<span class="media" data-alt="" data-src="$2"></span>')
    // a picture pasted inline as data that never closed: it was cut off on the way
    .replace(/!\[([^\]\n]*)\]\(data:[^)\s]*$/, '<span class="media" data-alt="$1" data-cut="1"></span>')
    .replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>")
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,;:!?]|$)/g, "$1<i>$2</i>")
    .replace(/\[([^\]\n]+)\]\((?:[^)\s]+)\)/g, "<u>$1</u>");
  return t.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${spans[i]}</code>`);
}

// Written without nested repeats on purpose: a single regex for a table rule backtracks
// catastrophically on a long line of pipes and dashes, which froze the page for most of a minute.
const isTableRow = (l) => { const t = l.trim(); return t.length > 1 && t[0] === "|" && t[t.length - 1] === "|"; };
const RULE_CELL = /^\s*:?-{2,}:?\s*$/;
const isRule = (l) => {
  const t = l.trim().replace(/^\|/, "").replace(/\|$/, "");
  return t.length > 0 && t.split("|").every((c) => RULE_CELL.test(c));
};
const cells = (l) => l.trim().replace(/^\||\|$/g, "").split("|").map((c) => inline(c.trim()));

export function renderMarkdown(src) {
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  const out = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const fence = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (fence) {
      const body = [];
      i++;
      while (i < lines.length && !new RegExp(`^\\s*${fence[1]}\\s*$`).test(lines[i])) body.push(lines[i++]);
      const closed = i < lines.length;
      i++; // closing fence (or end of a still-streaming block)
      // a diagram is drawn by the page once its block is complete (see diagram.js); half a diagram
      // would only be a syntax error, so while it streams in it says so
      if (/^(mermaid|diagram|flowchart)$/.test(fence[2])) {
        out.push(`<div class="diagram${closed ? "" : " pending"}" data-src="${encodeURIComponent(body.join("\n"))}">${closed ? "" : "Drawing the diagram…"}</div>`);
        continue;
      }
      // a chart block is drawn, not shown as code; while it streams in, it says so
      if (fence[2] === "chart") { out.push(renderChart(body.join("\n"))); continue; }
      const lang = fence[2] ? ` data-lang="${esc(fence[2])}"` : "";
      out.push(`<pre${lang}><code>${esc(body.join("\n"))}</code></pre>`);
      continue;
    }
    if (isTableRow(line) && i + 1 < lines.length && isRule(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows = [];
      while (i < lines.length && isTableRow(lines[i])) rows.push(cells(lines[i++]));
      out.push(`<div class="tbl"><table><thead><tr>${head.map((c) => `<th>${c}</th>`).join("")}</tr></thead><tbody>${rows.map((r) => `<tr>${r.map((c) => `<td>${c}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) { out.push(`<div class="h h${h[1].length}">${inline(h[2])}</div>`); i++; continue; }
    const li = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(line);
    if (li) {
      const ordered = /\d/.test(li[2]);
      const items = [];
      while (i < lines.length) {
        const m = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/.exec(lines[i]);
        if (!m) break;
        if (!m[1] && /\d/.test(m[2]) !== ordered) break; // a top-level switch between bullets and numbers starts a new list
        const depth = Math.min(4, Math.floor(m[1].replace(/\t/g, "  ").length / 2));
        items.push(`<li style="margin-left:${depth * 1.2}em"${/\d/.test(m[2]) ? ` value="${parseInt(m[2])}"` : ""}>${inline(m[3])}</li>`);
        i++;
      }
      out.push(ordered ? `<ol>${items.join("")}</ol>` : `<ul>${items.join("")}</ul>`);
      continue;
    }
    if (!line.trim()) { i++; continue; }
    const para = [];
    while (i < lines.length && lines[i].trim() && !/^\s*(```|~~~)/.test(lines[i]) && !/^#{1,6}\s/.test(lines[i]) && !/^(\s*)([-*+]|\d+[.)])\s+/.test(lines[i]) && !isTableRow(lines[i])) para.push(inline(lines[i++]));
    out.push(`<p>${para.join("<br>")}</p>`);
  }
  return out.join("");
}

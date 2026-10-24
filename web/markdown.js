// Small markdown renderer for the behind-the-scenes panel. Safe to call on a half-streamed
// document: an unclosed ``` fence renders as code so far, and whitespace inside code is kept
// exactly (indentation, blank lines, long lines scroll instead of wrapping).

export const esc = (s) => s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

function inline(s) {
  // protect code spans first so their contents are not formatted
  const spans = [];
  let t = esc(s).replace(/`([^`\n]+)`/g, (_, c) => `\u0000${spans.push(c) - 1}\u0000`);
  t = t
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
      i++; // closing fence (or end of a still-streaming block)
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

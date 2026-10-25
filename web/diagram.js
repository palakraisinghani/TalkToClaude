// Diagrams on the canvas: flows, pipelines, architectures, sequences, states.
//
// An agent explaining how something fits together writes a ```mermaid block; here it is drawn as a
// picture with Mermaid, running in the page — no service, nothing leaves the machine. The library
// is large, so it is loaded the first time a diagram appears, not before. Each drawing is kept by
// its source: the canvas re-renders as text streams in, and a diagram already drawn comes back at
// once instead of being drawn again. A diagram with a mistake in it shows its source and what is
// wrong, never a blank box.

let loading = null;
function mermaidReady() {
  loading ??= new Promise((resolve, reject) => {
    if (window.mermaid) return resolve(window.mermaid);
    const s = document.createElement("script");
    s.src = "/vendor/mermaid/mermaid.min.js";
    s.onload = () => resolve(window.mermaid);
    s.onerror = () => { loading = null; reject(new Error("the diagram library did not load")); };
    document.head.appendChild(s);
  });
  return loading;
}

const drawn = new Map(); // source -> svg markup, or { error }
let seq = 0;
let themed = null;

function theme() {
  const dark = document.documentElement.dataset.theme === "dark" || (!document.documentElement.dataset.theme && matchMedia("(prefers-color-scheme: dark)").matches);
  return dark ? "dark" : "neutral";
}

/** Draw every finished diagram inside `root` that is not drawn yet. */
export async function drawDiagrams(root) {
  const todo = [...root.querySelectorAll(".diagram:not(.pending):not(.drawn)")];
  if (!todo.length) return;
  let mermaid;
  try { mermaid = await mermaidReady(); } catch (e) { for (const el of todo) fail(el, e.message); return; }
  const t = theme();
  if (themed !== t) {
    // a change of light or dark redraws in the new colours
    mermaid.initialize({ startOnLoad: false, securityLevel: "strict", theme: t, fontFamily: "system-ui, -apple-system, sans-serif", flowchart: { htmlLabels: false, curve: "basis" } });
    if (themed) drawn.clear();
    themed = t;
  }
  for (const el of todo) {
    const src = decodeURIComponent(el.dataset.src ?? "");
    let got = drawn.get(src);
    if (!got) {
      try {
        const { svg } = await mermaid.render(`cc-diagram-${++seq}`, src);
        got = svg;
      } catch (e) {
        got = { error: String(e?.message ?? e).split("\n")[0] };
      }
      drawn.set(src, got);
      if (drawn.size > 60) drawn.delete(drawn.keys().next().value);
    }
    if (!el.isConnected) continue;
    if (typeof got === "string") show(el, got, src);
    else fail(el, got.error, src);
  }
}

function show(el, svg, src) {
  el.classList.add("drawn");
  el.innerHTML = `<div class="dtools"><button data-act="expand" title="Open large">⤢</button><button data-act="save" title="Download as SVG">⤓</button></div>${svg}`;
  el.querySelector("[data-act=expand]").onclick = () => expand(svg);
  el.querySelector("[data-act=save]").onclick = () => save(svg, src);
  el.ondblclick = () => expand(svg);
}

function fail(el, why, src = decodeURIComponent(el.dataset.src ?? "")) {
  el.classList.add("drawn", "broken");
  const pre = document.createElement("pre");
  pre.textContent = src;
  el.replaceChildren(Object.assign(document.createElement("div"), { className: "derr", textContent: `This diagram could not be drawn: ${why}` }), pre);
}

/** The diagram filling the screen, to read the small print or follow a long flow. */
function expand(svg) {
  let dlg = document.getElementById("diagramDlg");
  if (!dlg) {
    dlg = document.createElement("dialog");
    dlg.id = "diagramDlg";
    dlg.className = "diagramdlg";
    dlg.innerHTML = `<button class="dclose" title="Close">✕</button><div class="dbody"></div>`;
    dlg.querySelector(".dclose").onclick = () => dlg.close();
    dlg.onclick = (e) => { if (e.target === dlg) dlg.close(); };
    document.body.appendChild(dlg);
  }
  dlg.querySelector(".dbody").innerHTML = svg;
  dlg.showModal();
}

function save(svg, src) {
  const title = (/^\s*(?:title|%%)\s*:?\s*(.+)$/m.exec(src)?.[1] ?? "diagram").replace(/[^\w -]+/g, "").trim().slice(0, 40) || "diagram";
  const a = Object.assign(document.createElement("a"), { href: URL.createObjectURL(new Blob([svg], { type: "image/svg+xml" })), download: `${title}.svg` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}

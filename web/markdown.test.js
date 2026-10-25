import { test } from "node:test";
import assert from "node:assert/strict";
import { renderMarkdown } from "./markdown.js";

test("code fences keep indentation, blank lines and long lines verbatim", () => {
  const code = "def f(x):\n    if x:\n\n        return '<a & b>'" + " ".repeat(3) + "x".repeat(200);
  const html = renderMarkdown("Here:\n```python\n" + code + "\n```\nafter");
  assert.match(html, /<pre data-lang="python"><code>def f\(x\):\n    if x:\n\n        return '&lt;a &amp; b&gt;' {3}x{200}<\/code><\/pre>/);
  assert.match(html, /<p>after<\/p>$/);
  assert.doesNotMatch(html, /<br>.*<\/code>/s);
});

test("an unclosed fence while streaming renders as code so far", () => {
  assert.equal(renderMarkdown("```js\nconst a = 1;\n  b()"), "<pre data-lang=\"js\"><code>const a = 1;\n  b()</code></pre>");
});

test("inline code is not formatted inside", () => {
  assert.equal(renderMarkdown("use `a*b*c` and **bold**"), "<p>use <code>a*b*c</code> and <b>bold</b></p>");
});

test("nested lists, numbered lists, tables", () => {
  const html = renderMarkdown("- one\n  - two\n1. first\n2. second\n\n| a | b |\n|---|---|\n| `x` | 2 |");
  assert.match(html, /<ul><li style="margin-left:0em">one<\/li><li style="margin-left:1.2em">two<\/li><\/ul>/);
  assert.match(html, /<ol><li style="margin-left:0em" value="1">first<\/li>/);
  assert.match(html, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead><tbody><tr><td><code>x<\/code><\/td><td>2<\/td><\/tr>/);
});

test("html is escaped everywhere", () => {
  assert.doesNotMatch(renderMarkdown("<script>x</script>\n# <b>h</b>"), /<script>|<b>h/);
});

test("long table-like lines render in linear time", () => {
  const nasty = "|" + " -- |".repeat(400) + " x";
  const table = ["| section | count |", "|---|---|", ...Array.from({ length: 300 }, (_, i) => `| ${i} | ${"-".repeat(60)} |`)].join("\n");
  const t = Date.now();
  renderMarkdown(`${nasty}\n${table}\n${"| ".repeat(3000)}`);
  assert.ok(Date.now() - t < 200, `took ${Date.now() - t}ms`);
  assert.match(renderMarkdown("| a | b |\n| :-- | --: |\n| 1 | 2 |"), /<table>.*<td>1<\/td>/);
});

test("an image becomes a media slot for the page to fill in, with its path escaped", () => {
  assert.match(renderMarkdown("see ![shot](out/a.png)"), /<span class="media" data-alt="shot" data-src="out\/a.png"><\/span>/);
  assert.doesNotMatch(renderMarkdown('![x]("onerror=alert(1))'), /data-src=""/);
});

test("links to GIFs, videos and YouTube, bare or named, become media slots; other links stay links", () => {
  assert.match(renderMarkdown("here https://media.giphy.com/media/abc/giphy.gif ok"), /data-src="https:\/\/media\.giphy\.com\/media\/abc\/giphy\.gif"/);
  assert.match(renderMarkdown("[demo](clips/run.mp4)"), /<u>demo<\/u>/); // a relative link is a link; ![…] is how to show a file
  assert.match(renderMarkdown("[the demo](https://x.dev/run.mp4)"), /data-alt="the demo" data-src="https:\/\/x\.dev\/run\.mp4"/);
  assert.match(renderMarkdown("https://www.youtube.com/watch?v=dQw4w9WgXcQ"), /class="media"/);
  assert.match(renderMarkdown("https://youtu.be/dQw4w9WgXcQ"), /class="media"/);
  assert.match(renderMarkdown("[docs](https://example.com/guide)"), /<u>docs<\/u>/);
  assert.doesNotMatch(renderMarkdown("`https://x.dev/a.gif`"), /class="media"/); // code stays code
});

test("a line that is only a path to a picture shows it; a picture pasted as data and cut off says so", () => {
  assert.match(renderMarkdown("`output/gallery/julia.png`"), /class="media" data-alt="" data-src="output\/gallery\/julia\.png"/);
  assert.match(renderMarkdown("~/shots/run.mp4"), /data-src="~\/shots\/run\.mp4"/);
  assert.doesNotMatch(renderMarkdown("see output/a.png for details"), /class="media"/); // a mention is not a request to show
  assert.match(renderMarkdown("![Julia set](data:image/jpeg;base64,/9j/4AAQSkZJRg"), /data-cut="1"/);
});

test("a mermaid block becomes a diagram to draw, held back until it is complete", () => {
  const done = renderMarkdown("```mermaid\nflowchart LR\n  A --> B\n```");
  assert.match(done, /<div class="diagram" data-src="flowchart%20LR/);
  const streaming = renderMarkdown("```mermaid\nflowchart LR\n  A -->");
  assert.match(streaming, /diagram pending/);
});

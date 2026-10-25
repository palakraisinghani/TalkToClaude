import { test } from "node:test";
import assert from "node:assert/strict";
import { parseChart, renderChart } from "./chart.js";

const spec = (o) => JSON.stringify({ type: "bar", labels: ["a", "b", "c"], series: [{ name: "x", data: [1, 2, 3] }], ...o });

test("a bar chart draws one mark per value, with a hit target per label and a data table", () => {
  const html = renderChart(spec({ series: [{ name: "x", data: [1, 2, 3] }, { name: "y", data: [3, -1, 2] }] }));
  assert.equal((html.match(/class="mark s\d"/g) ?? []).length, 6);
  assert.equal((html.match(/class="hit"/g) ?? []).length, 3);
  assert.match(html, /class="legend"/); // two series: a legend
  assert.match(html, /<details class="data">/);
});

test("one series needs no legend; colours follow the series in a fixed order", () => {
  const html = renderChart(spec());
  assert.doesNotMatch(html, /class="legend"/);
  assert.match(html, /class="mark s1"/);
});

test("a line chart draws a path per series and labels a few lines directly", () => {
  const html = renderChart(spec({ type: "line", series: [{ name: "api", data: [3, 2, 1] }, { name: "web", data: [1, null, 2] }] }));
  assert.equal((html.match(/class="line s\d"/g) ?? []).length, 2);
  assert.equal((html.match(/class="direct"/g) ?? []).length, 2);
});

test("a half-streamed or broken block says so instead of throwing", () => {
  assert.match(renderChart('{"type": "ba'), /drawing/);
  assert.match(renderChart('{"labels": []}'), /needs at least one series/);
  assert.equal(parseChart(spec({ series: Array.from({ length: 12 }, (_, i) => ({ name: `s${i}`, data: [1, 2, 3] })) })).series.length, 8);
});

test("labels and names are escaped", () => {
  const html = renderChart(spec({ title: "<b>t</b>", labels: ["<script>", "b", "c"] }));
  assert.doesNotMatch(html, /<script>|<b>t/);
});

test("a scatter plot uses numeric axes for both x and y", () => {
  const c = parseChart(JSON.stringify({ type: "scatter", series: [{ name: "runs", points: [[1.5, 30], [2.25, 41], [9, 12]] }] }));
  assert.equal(c.numeric, true);
  assert.deepEqual(c.series[0].points.map((p) => p.x), [1.5, 2.25, 9]);
  const html = renderChart(JSON.stringify({ type: "scatter", series: [{ name: "runs", points: [[1.5, 30], [2.25, 41], [9, 12]] }] }));
  assert.equal((html.match(/class="dot s1"/g) ?? []).length, 3);
  assert.doesNotMatch(html, /class="line/);
});

test("a function plots against a numeric x, at its true spacing", () => {
  const x = [0, 0.1, 0.5, 2];
  const c = parseChart(JSON.stringify({ type: "line", x, series: [{ name: "f", data: [0, 0.01, 0.25, 4] }] }));
  assert.equal(c.numeric, true);
  assert.deepEqual(c.series[0].points, [{ x: 0, y: 0 }, { x: 0.1, y: 0.01 }, { x: 0.5, y: 0.25 }, { x: 2, y: 4 }]);
});

test("area, horizontal and stacked bars all draw", () => {
  const base = { labels: ["a", "b"], series: [{ name: "x", data: [1, 2] }, { name: "y", data: [3, 1] }] };
  assert.match(renderChart(JSON.stringify({ ...base, type: "area" })), /class="fill s1"/);
  const h = renderChart(JSON.stringify({ ...base, type: "hbar" }));
  assert.equal((h.match(/class="mark s\d"/g) ?? []).length, 4);
  const st = parseChart(JSON.stringify({ ...base, type: "bar", stacked: true }));
  assert.equal(st.stacked, true);
  assert.equal((renderChart(JSON.stringify({ ...base, type: "bar", stacked: true })).match(/class="mark s\d"/g) ?? []).length, 4);
});

test("axis titles show, and a pie is drawn as bars", () => {
  const html = renderChart(JSON.stringify({ type: "line", xLabel: "seconds", yLabel: "ms", labels: ["a", "b"], series: [{ name: "p95", data: [1, 2] }] }));
  assert.match(html, />seconds</);
  assert.match(html, />ms</);
  assert.equal(parseChart(JSON.stringify({ type: "pie", labels: ["a", "b"], series: [{ data: [1, 2] }] })).type, "hbar");
});

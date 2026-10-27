import { test } from "node:test";
import assert from "node:assert/strict";
import { collapse, move, normalise, resize, swap } from "./deck.js";
import { flipped, natural } from "./diagram.js";
import { callHeader } from "../server/context.ts";

test("the deck: order, moving, swapping, collapsing and resizing", () => {
  let l = normalise(null);
  assert.deepEqual(l.order, ["head", "room", "canvas", "feed"]);
  // a broken saved layout falls back, a good one is kept
  assert.deepEqual(normalise({ order: ["x"] }).order, l.order);
  assert.deepEqual(normalise({ order: ["feed", "canvas", "room", "head"] }).order, ["feed", "canvas", "room", "head"]);
  l = move(l, "canvas", -1);
  assert.deepEqual(l.order, ["head", "canvas", "room", "feed"]);
  assert.deepEqual(move(l, "head", -1).order, l.order, "the first cannot move further left");
  l = swap(l, "feed", "head");
  assert.deepEqual(l.order, ["feed", "canvas", "room", "head"]);
  l = collapse(collapse(collapse(l, "feed", true), "canvas", true), "head", true);
  assert.deepEqual(Object.keys(l.collapsed).sort(), ["canvas", "feed", "head"]);
  assert.equal(collapse(l, "room", true), l, "never every section collapsed");
  // a divider moves width from one neighbour to the other, never below a minimum
  const w = { head: 272, room: 500, canvas: 600, feed: 380 };
  const r = resize(normalise(null), "room", "canvas", 150, w);
  assert.deepEqual([r.weight.room, r.weight.canvas], [650, 450]);
  const clamped = resize(normalise(null), "room", "canvas", 900, w);
  assert.equal(clamped.weight.canvas, 300);
  assert.equal(clamped.weight.room + clamped.weight.canvas, 1100);
});

test("diagrams: a left-to-right flow can be redrawn top to bottom; the canvas size reaches the agent", () => {
  assert.equal(flipped("flowchart LR\n  A --> B"), "flowchart TD\n  A --> B");
  assert.equal(flipped("graph RL; A-->B"), "graph TD; A-->B");
  assert.equal(flipped("sequenceDiagram\n A->>B: hi"), null);
  assert.deepEqual(natural('<svg viewBox="0 0 1840.5 220" width="100%">'), { w: 1840.5, h: 220 });
  assert.match(callHeader("visual", true, "650×800"), /canvas 650×800 px\]$/);
  assert.doesNotMatch(callHeader("audio", true, "650×800"), /canvas/);
});

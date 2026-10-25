import { test } from "node:test";
import assert from "node:assert/strict";
import { gerund, narrate } from "./narration.ts";

test("updates say what the agent is actually doing", () => {
  assert.equal(narrate("Bash", { command: "npm i", description: "Install dependencies" }), "installing dependencies");
  assert.equal(narrate("Bash", { command: "curl -O https://x.org/dataset.zip" }), "downloading the dataset");
  assert.equal(narrate("Bash", { command: "python train.py --epochs 5" }), "training the model");
  assert.equal(narrate("Bash", { command: "pytest -q" }), "running the tests");
  assert.equal(narrate("Write", { file_path: "/a/scraper.py" }), "writing a Python script, scraper");
  assert.equal(narrate("Write", { file_path: "/a/index.html" }), "writing the web page");
  assert.equal(narrate("Edit", { file_path: "/a/style.css" }), "changing the page's styles");
});

test("instructions become what is being done", () => {
  assert.equal(gerund("Run the build"), "running the build");
  assert.equal(gerund("Create the database"), "creating the database");
  assert.equal(gerund("Download weights"), "downloading weights");
  assert.equal(gerund("Write a Python script for the scraper"), "writing a Python script for the scraper");
});

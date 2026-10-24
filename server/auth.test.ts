import { test } from "node:test";
import assert from "node:assert/strict";
import { Auth } from "./auth.ts";

test("only the exact code is accepted", () => {
  const a = new Auth("testcode1");
  assert.ok(a.check("testcode1"));
  assert.ok(!a.check(undefined));
  assert.ok(!a.check(""));
  assert.ok(!a.check("testcode"));   // one short
  assert.ok(!a.check("testcode12")); // one long
  assert.ok(!a.check("testcode2"));
});

test("case does not matter, so a phone keyboard cannot lock you out", () => {
  assert.ok(new Auth("TestCode1").check("testcode1"));
  assert.ok(new Auth("testcode1").check("TESTCODE1"));
});

test("a generated code is long enough to be hopeless to guess", () => {
  const a = new Auth(undefined);
  assert.ok(a.generated);
  assert.match(a.code, /^[0-9a-f]{10}$/);
});

test("a flood is slowed down, but a handful of typos is not", () => {
  const a = new Auth("abc");
  for (let i = 0; i < 9; i++) a.failed("1.2.3.4");
  assert.ok(!a.blocked("1.2.3.4"), "nine typos should still let you try");
  a.failed("1.2.3.4");
  assert.ok(a.blocked("1.2.3.4"));
  assert.ok(a.waitSeconds("1.2.3.4") > 0);
  // and one source being blocked does not affect another
  assert.ok(!a.blocked("5.6.7.8"));
});

test("getting in clears the record", () => {
  const a = new Auth("abc");
  for (let i = 0; i < 12; i++) a.failed("1.2.3.4");
  assert.ok(a.blocked("1.2.3.4"));
  a.passed("1.2.3.4");
  assert.ok(!a.blocked("1.2.3.4"));
  assert.equal(a.waitSeconds("1.2.3.4"), 0);
});

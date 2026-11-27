// node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { Nav, entryOf, MAX, SETTLE_MS } from "../vscode-layout/mods/k-chrome/nav.js";

const at = (tab, pane, terminal = `t-${pane}`) => entryOf({ space: "s", tab, pane, terminal, shown: null });
const A = at("tb1", "p1"), B = at("tb2", "p2"), C = at("tb3", "p3"), D = at("tb4", "p4");

// Presses a key, then the window's focus lands on the target (as the app would report it).
const go = (nav, target, now) => { if (target) nav.visit(target, now); return target; };

test("entryOf: tab + pane; a layout terminal block goes by its terminal; nothing shown is null", () => {
  assert.equal(entryOf(null), null);
  assert.equal(entryOf({ space: "s", tab: "" }), null);
  assert.equal(A.key, "tb1|p1");
  assert.equal(entryOf({ space: "s", tab: "tb1", pane: null, terminal: "t9" }).key, "tb1|t9");
  assert.equal(entryOf({ space: "s", tab: "tb1", pane: "p1", terminal: "t1", shown: "t7" }).terminal, "t7");
});

test("back and forward walk what was looked at", () => {
  const nav = new Nav();
  for (const e of [A, B, C]) nav.visit(e, 0);
  assert.equal(go(nav, nav.step(-1, undefined, 10), 11), B);
  assert.equal(go(nav, nav.step(-1, undefined, 20), 21), A);
  assert.equal(nav.step(-1, undefined, 30), null);
  assert.equal(go(nav, nav.step(1, undefined, 40), 41), B);
  assert.equal(go(nav, nav.step(1, undefined, 50), 51), C);
  assert.equal(nav.step(1, undefined, 60), null);
  assert.deepEqual(nav.entries.map((e) => e.key), [A.key, B.key, C.key]);
});

test("going somewhere new after going back drops the forward part", () => {
  const nav = new Nav();
  for (const e of [A, B, C]) nav.visit(e, 0);
  go(nav, nav.step(-1, undefined, 10), 11);
  nav.visit(D, 5000);
  assert.deepEqual(nav.entries.map((e) => e.key), [A.key, B.key, D.key]);
  assert.equal(nav.step(1, undefined, 6000), null);
});

test("what the window passes through on the way to the target is not recorded", () => {
  const nav = new Nav();
  for (const e of [A, B, C]) nav.visit(e, 0);
  const target = nav.step(-2 + 1, undefined, 100);
  nav.visit(D, 110);            // the other space's own tab shows for a moment
  nav.visit(target, 120);
  assert.deepEqual(nav.entries.map((e) => e.key), [A.key, B.key, C.key]);
  assert.equal(nav.current, B);
  // The target never showed: after the wait, where the window is counts again.
  nav.step(-1, undefined, 200);
  nav.visit(D, 200 + SETTLE_MS + 1);
  assert.equal(nav.current.key, D.key);
});

test("the same place twice in a row is one entry; seen again later it moves to the end", () => {
  const nav = new Nav();
  for (const e of [A, A, B, A]) nav.visit(e, 0);
  assert.deepEqual(nav.entries.map((e) => e.key), [B.key, A.key]);
});

test("closed sessions are skipped and forgotten", () => {
  const nav = new Nav();
  for (const e of [A, B, C]) nav.visit(e, 0);
  assert.equal(nav.step(-1, (e) => e.key !== B.key, 10), A);
  assert.deepEqual(nav.entries.map((e) => e.key), [A.key, C.key]);
});

test("the history is capped", () => {
  const nav = new Nav();
  for (let i = 0; i < MAX + 20; i++) nav.visit(at(`tb${i}`, `p${i}`), 0);
  assert.equal(nav.entries.length, MAX);
  assert.equal(nav.current.key, `tb${MAX + 19}|p${MAX + 19}`);
});

test("last input: the looked-at terminal started working", () => {
  const nav = new Nav();
  const list = (a, b) => [{ address: A.terminal, status: a }, { address: B.terminal, status: b }, { address: "sh" }];
  assert.equal(nav.input(list("working", "idle"), A), false);   // first look: nothing to compare with
  assert.equal(nav.input(list("idle", "working"), A), false);   // another agent started, not the one in front
  assert.equal(nav.lastInput, null);
  assert.equal(nav.input(list("working", "working"), A), true);
  assert.equal(nav.lastInput, A);
  assert.equal(nav.input(list("working", "working"), A), false);
  assert.equal(nav.input(list("done", "idle"), B), false);      // a turn ending is not input
  assert.equal(nav.input(list("done", "idle"), at("tb9", "p9", "sh")), false);
  assert.equal(nav.lastInput, A);
  assert.equal(nav.input(list("done", "working"), B), true);    // blocked / done / idle → working all count
  assert.equal(nav.lastInput, B);
});

test("to last input: recorded like any visit; nothing to do when already there or it is gone", () => {
  const nav = new Nav();
  nav.visit(A, 0);
  nav.input([{ address: A.terminal, status: "idle" }], A);
  nav.input([{ address: A.terminal, status: "working" }], A);
  assert.equal(nav.toInput(undefined, 1), null);
  nav.visit(B, 2); nav.visit(C, 3);
  const target = nav.toInput(undefined, 10);
  assert.equal(target, A);
  nav.visit(D, 11);             // passing through
  nav.visit(A, 12);
  assert.deepEqual(nav.entries.map((e) => e.key), [B.key, C.key, A.key]);
  assert.equal(go(nav, nav.step(-1, undefined, 20), 21), C);
  assert.equal(nav.toInput(() => false, 30), null);
  assert.equal(nav.lastInput, null);
});

// node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { opened, neighbour, moved, cycled, trimmed, others } from "../vscode-layout/mods/k-tabs/open.js";

test("opened: a tab shown for the first time goes right of the one shown before", () => {
  const open = ["a", "b", "c"];
  assert.equal(opened(open, "b", "a"), open);
  assert.equal(opened(open, null, "a"), open);
  assert.deepEqual(opened(open, "x", "a"), ["a", "x", "b", "c"]);
  assert.deepEqual(opened(open, "x", "gone"), ["a", "b", "c", "x"]);
  assert.deepEqual(opened([], "x", undefined), ["x"]);
  assert.deepEqual(open, ["a", "b", "c"]);
});

test("neighbour: right of the closed one, else left, else nothing", () => {
  assert.equal(neighbour(["a", "b", "c"], "b"), "c");
  assert.equal(neighbour(["a", "b", "c"], "c"), "b");
  assert.equal(neighbour(["a"], "a"), null);
  assert.equal(neighbour(["a", "b"], "x"), null);
});

test("moved: dropped where the other one is", () => {
  assert.deepEqual(moved(["a", "b", "c", "d"], "a", "c"), ["b", "c", "a", "d"]);
  assert.deepEqual(moved(["a", "b", "c", "d"], "d", "b"), ["a", "d", "b", "c"]);
  const open = ["a", "b"];
  assert.equal(moved(open, "a", "a"), open);
  assert.equal(moved(open, "a", "x"), open);
});

test("cycled: wraps", () => {
  assert.equal(cycled(["a", "b", "c"], "c", 1), "a");
  assert.equal(cycled(["a", "b", "c"], "a", -1), "c");
  assert.equal(cycled(["a", "b", "c"], "x", 1), "a");
  assert.equal(cycled([], "a", 1), null);
});

test("trimmed: only a long list drops tabs that are gone", () => {
  const open = ["a", "gone", "b"];
  assert.equal(trimmed(open, (id) => id !== "gone"), open);
  assert.deepEqual(trimmed(open, (id) => id !== "gone", 2), ["a", "b"]);
  assert.deepEqual(trimmed(["a", "b", "c"], () => true, 2), ["b", "c"]);
});

test("others: all but the one kept; nothing when it isn't on the bar", () => {
  assert.deepEqual(others(["a", "b", "c"], "b"), ["a", "c"]);
  assert.deepEqual(others(["a"], "a"), []);
  assert.deepEqual(others(["a", "b"], "x"), []);
});

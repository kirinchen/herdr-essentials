// node --test tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import { chipsFor, modsIn, safeUrl, placeOf } from "../vscode-layout/mods/k-pane/core.js";

const layout = { children: [
  { content: { mod: "cards" } },
  { children: [{ content: { tab: "active", pane: { header: { content: { mod: "k-pane" } } } } }, { content: { mod: "builds" } }] },
] };

test("modsIn: blocks and pane headers", () => {
  assert.deepEqual([...modsIn(layout)].sort(), ["builds", "cards", "k-pane"]);
  assert.deepEqual([...modsIn(null)], []);
});

test("chipsFor: every mod's chip for this terminal, only mods in the layout", () => {
  const given = {
    cards: { t1: { label: "#1", text: " a\n b ", tag: "DOING", color: "working", url: "http://x.test/1" }, t2: { label: "#2" } },
    builds: { t1: { tag: "ok" } },
    gone: { t1: { label: "stale" } },
  };
  const chips = chipsFor(given, "t1", modsIn(layout));
  assert.deepEqual(chips.map((c) => c.by), ["builds", "cards"]);
  assert.equal(chips[1].text, "a b");
  assert.equal(chips[1].url, "http://x.test/1");
  assert.deepEqual(chipsFor(given, "t9", modsIn(layout)), []);
});

test("chipsFor: anything else in there is ignored", () => {
  const mods = new Set(["cards"]);
  for (const given of [null, undefined, "x", [], { cards: null }, { cards: "x" }, { cards: { t1: "x" } }, { cards: { t1: {} } }, { cards: { t1: { label: 5 } } }]) assert.deepEqual(chipsFor(given, "t1", mods), []);
  assert.deepEqual(chipsFor({ cards: { t1: { label: "a" } } }, null, mods), []);
});

test("safeUrl: http and https only", () => {
  assert.equal(safeUrl("https://x.test/a?b=1&c=2#d"), "https://x.test/a?b=1&c=2#d");
  for (const u of ["file:///etc/passwd", "javascript:alert(1)", "http://x.test/ a", 'http://x.test/"', "", null, 5]) assert.equal(safeUrl(u), null, String(u));
});

test("placeOf: the machine and the space of a pane's tab", () => {
  const spaces = [
    { name: "kelp", machine: null, tabs: [{ id: "tb1" }] },
    { name: "aura-stream", machine: "back", tabs: [{ id: "back/tb2" }, { id: "back/tb3" }] },
  ];
  assert.deepEqual(placeOf(spaces, "back/tb3"), { machine: "back", space: "aura-stream" });
  assert.deepEqual(placeOf(spaces, "tb1"), { machine: null, space: "kelp" });
  assert.deepEqual(placeOf(spaces, "gone"), { machine: null, space: "" });
  assert.deepEqual(placeOf(null, "tb1"), { machine: null, space: "" });
});

import { switchKind, switchItems, targetOf } from "../vscode-layout/mods/k-pane/core.js";

test("model menu: Claude Code gets models and efforts, Codex its own picker, others nothing", () => {
  assert.equal(switchKind({ name: "Claude Code" }), "claude");
  assert.equal(switchKind({ name: "Codex" }), "codex");
  assert.equal(switchKind({ name: "agy" }), null);
  const c = switchItems("claude", { kind: "opus", effort: "high" });
  assert.deepEqual(c.map((i) => i.send), ["/model fable", "/model opus", "/model sonnet", "/model haiku",
    "/effort low", "/effort medium", "/effort high", "/effort xhigh", "/effort max"]);
  assert.deepEqual(c.filter((i) => i.now).map((i) => i.send), ["/model opus", "/effort high"]);
  assert.equal(c.find((i) => i.rule).send, "/effort low");
  assert.deepEqual(switchItems("codex", null).map((i) => i.send), ["/model"]);
  assert.deepEqual(switchItems(null, null), []);
});

test("targetOf: machine prefix becomes exec's `on`", () => {
  assert.deepEqual(targetOf("laptop/t10"), { on: "laptop", id: "t10" });
  assert.deepEqual(targetOf("t6n"), { on: null, id: "t6n" });
});

import { readdirSync as ls, readFileSync as read } from "node:fs";
import { modDir } from "./paths.js";

test("the layout package's k-attach is the k-attach package's, file for file", () => {
  const a = modDir("k-attach", "k-attach"), b = modDir("vscode-layout", "k-attach");
  const files = (d) => ls(d).filter((f) => !/^(gpui-kit\.d\.ts|jsconfig\.json)$/.test(f)).sort();
  assert.deepEqual(files(b), files(a), "cp -r k-attach/mods/k-attach/. vscode-layout/mods/k-attach/");
  for (const f of files(a)) assert.equal(read(`${b}/${f}`, "utf8"), read(`${a}/${f}`, "utf8"), `vscode-layout/mods/k-attach/${f} is out of date: cp k-attach/mods/k-attach/${f} vscode-layout/mods/k-attach/`);
});

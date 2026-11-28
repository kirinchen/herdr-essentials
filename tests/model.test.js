// node --test tests/
// k-agents' model.js (which model an agent runs, and its icon) and the copies other mods carry.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { modelOf, effortLevel, modelTip, MODELS } from "../vscode-layout/mods/k-agents/model.js";

import { modDirs, modDir } from "./paths.js";

const source = modDir("vscode-layout", "k-agents");
const copies = modDirs().filter((m) => m.name !== "k-agents" && existsSync(join(m.dir, "model.js")));

test("every copy of model.js and of its icons equals k-agents'", () => {
  assert.ok(copies.some((m) => m.name === "k-pane"), "k-pane carries a copy");
  const files = ["model.js", ...MODELS.map(([, kind]) => `m-${kind}.svg`)];
  for (const m of copies) for (const f of files) {
    assert.ok(existsSync(join(m.dir, f)), `${m.pkg}/mods/${m.name}/${f} is missing: cp vscode-layout/mods/k-agents/${f} ${m.pkg}/mods/${m.name}/`);
    assert.equal(readFileSync(join(m.dir, f), "utf8"), readFileSync(join(source, f), "utf8"), `${m.pkg}/mods/${m.name}/${f} is out of date: cp vscode-layout/mods/k-agents/${f} ${m.pkg}/mods/${m.name}/`);
  }
});

test("modelOf: Claude Code's labels", () => {
  const m = modelOf({ labels: { "herdr.model": "Fable 5.2", "herdr.effort": "High" } }, "mods/k-pane");
  assert.deepEqual(m, { model: "Fable 5.2", effort: "high", kind: "fable", icon: "mods/k-pane/m-fable.svg", color: "#a970ff" });
  assert.equal(modelTip(m), "Fable 5.2 · high");
  assert.equal(modelOf({ labels: { "herdr.model": "Opus 5.5" } }, "d").icon, "d/m-opus.svg");
});

test("modelOf: Codex from its command line, also under a shell", () => {
  const m = modelOf({ foreground: { argv: ["/usr/bin/codex", "-m", "gpt-5-codex", "-c", 'model_reasoning_effort="xhigh"'] } }, "d");
  assert.equal(m.kind, "codex");
  assert.equal(m.effort, "xhigh");
  assert.equal(modelOf({ argv: ["codex", "--model=gpt-5-mini"] }, "d").kind, "mini");
  assert.equal(modelOf({ argv: ["codex"] }, "d"), null);
});

test("modelOf: nothing known, or a model without an icon", () => {
  assert.equal(modelOf(undefined, "d"), null);
  assert.equal(modelOf({ labels: {} }, "d"), null);
  assert.equal(modelOf({ labels: { "herdr.model": "Llama" } }, "d").icon, null);
  assert.equal(modelTip(null), "");
});

test("effortLevel", () => {
  assert.deepEqual(["low", "medium", "high", "xhigh", "max", null].map(effortLevel), [0, 1, 2, 3, 3, 0]);
});

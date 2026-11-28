// Tests for k-float (run: node --test tests/).
// A mod can only import from its own folder ("resolves outside the application directory"), so every
// mod that uses the SDK carries a copy of k-float/mods/k-float/float.js. They must stay the same file:
//   cp k-float/mods/k-float/float.js mods/<mod>/float.js
import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync, existsSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { modDirs, modDir, ROOT } from "./paths.js";

const source = readFileSync(join(modDir("k-float", "k-float"), "float.js"), "utf8");

test("every copy of float.js equals k-float/mods/k-float/float.js", () => {
  const copies = modDirs().filter((m) => m.name !== "k-float" && existsSync(join(m.dir, "float.js")));
  assert.ok(copies.some((m) => m.name === "k-note"), "k-note carries a copy");
  for (const m of copies) assert.equal(readFileSync(join(m.dir, "float.js"), "utf8"), source, `${m.pkg}/mods/${m.name}/float.js is out of date: cp k-float/mods/k-float/float.js ${m.pkg}/mods/${m.name}/float.js`);
});

test("no mod imports float.js from another mod's folder", () => {
  for (const m of modDirs()) {
    for (const f of readdirSync(m.dir).filter((f) => f.endsWith(".js"))) {
      assert.doesNotMatch(readFileSync(join(m.dir, f), "utf8"), /from\s+["']\.\.\/[^"']*float\.js["']/, `${m.pkg}/mods/${m.name}/${f}`);
    }
  }
});

// What a page gets (window.float) lives in the helper; float.js and the protocol document describe it.
// A name that exists in one and not the others is a page written from the docs that doesn't work.
test("the collapse / hover names are the same in the helper, float.js and the protocol document", () => {
  const top = ROOT;
  const helper = readFileSync(join(top, "k-float", "tools", "k-float", "src", "main.rs"), "utf8");
  const doc = readFileSync(join(top, "doc", "k-float-protocol.md"), "utf8");
  for (const name of ["hoverOpacity", "collapsed", "collapsedWidth", "collapsedHeight", "collapseAnchor", "data-float-drag-click", "data-float-collapsed", "onCollapsed"]) {
    assert.ok(doc.includes(name), `doc/k-float-protocol.md doesn't mention ${name}`);
    if (!name.includes("-") && name !== "onCollapsed") assert.ok(source.includes(name), `float.js doesn't mention ${name}`);
  }
  // The helper reads the spec's fields in snake_case (serde renames them) and the page API verbatim.
  for (const name of ["hover_opacity", "collapsed_width", "collapsed_height", "collapse_anchor", "collapse(size)", "expand()", "onCollapsed(fn)", "data-float-drag-click", "data-float-collapsed", '"collapsedWidth"', '"collapsedHeight"']) {
    assert.ok(helper.includes(name), `tools/k-float/src/main.rs doesn't have ${name}`);
  }
  for (const event of ["collapsed", "expanded"]) assert.ok(helper.includes(`"${event}"`) && doc.includes(`\`${event}\``), `event ${event}`);
});

test("float.collapse / float.expand write only the collapse fields", async () => {
  // float.js imports the App's modules; run its two methods against a stand-in update().
  const body = (name) => source.match(new RegExp(`async ${name}\\(([^)]*)\\) \\{([\\s\\S]*?)\\n  \\},`));
  const calls = [];
  const self = { update: async (id, patch) => { calls.push([id, patch]); return true; } };
  const AsyncFunction = (async () => {}).constructor;
  for (const name of ["collapse", "expand"]) assert.ok(body(name), `float.${name} is there`);
  const collapse = new AsyncFunction("id", "size", body("collapse")[2]), expand = new AsyncFunction("id", body("expand")[2]);
  assert.equal(await collapse.call(self, "a"), true);
  await collapse.call(self, "a", { width: 40, height: 36 });
  await collapse.call(self, "a", { width: 0, height: 36 });
  await expand.call(self, "a");
  assert.deepEqual(calls, [
    ["a", { collapsed: true }],
    ["a", { collapsed: true, collapsedWidth: 40, collapsedHeight: 36 }],
    ["a", { collapsed: true }],
    ["a", { collapsed: false }],
  ]);
});

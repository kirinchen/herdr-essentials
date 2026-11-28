// Tests for vscode-layout/mods/k-settings/core.js (the Mods page, was k-mods) (run: node --test tests/). Derived from the tests of
// jacksonpires/herdr-app-mod-manager (MIT, see vscode-layout/mods/k-settings/LICENSE).
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, symlinkSync, lstatSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import * as core from "../vscode-layout/mods/k-settings/core.js";

const io = {
  platform: process.platform === "darwin" ? "macos" : "linux",
  async exec(cmd, args, opts) {
    if (cmd === "herdr-app") return { code: args[1].endsWith("/broken") ? 1 : 0, stdout: "", stderr: "SyntaxError (test)" };
    const r = spawnSync(cmd, args, { cwd: opts?.cwd, encoding: "utf8" });
    return { code: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
  },
  async readText(path) {
    return existsSync(path) ? readFileSync(path, "utf8") : null;
  },
  async writeText(path, text) {
    writeFileSync(path, text);
  },
};

function put(root, files) {
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), text);
  }
}

function repo(files) {
  const dir = mkdtempSync(join(tmpdir(), "km-repo-"));
  put(dir, files);
  const git = (...a) => execFileSync("git", ["-C", dir, ...a], { stdio: "pipe" });
  const commit = (m) => git("-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", "commit", "-q", "-m", m);
  git("init", "-q", "-b", "main");
  git("add", "-A");
  commit("x");
  return { dir, commit: (more) => { put(dir, more); git("add", "-A"); commit("y"); } };
}

function home(keys = { global: { "cmd-p": "mod.open:picker" } }) {
  const dir = mkdtempSync(join(tmpdir(), "km-home-"));
  put(dir, {
    "keys.json": JSON.stringify(keys, null, 2),
    "installed.json": JSON.stringify({ agents: {}, picker: {} }),
    "mods/agents/main.js": "",
    "mods/picker/main.js": "",
    "mods/mine/main.js": "",
    "mods/mine/mod.json": JSON.stringify({ place: "none", title: "Mine" }),
    "layouts/main.json": JSON.stringify({ type: "row", children: [{ type: "block", content: { mod: "agents" } }] }),
    "layouts/k-main.json": JSON.stringify({ type: "row", children: [{ type: "block", content: { mod: "mine", props: {} } }] }),
  });
  return dir;
}

const keys = (dir) => JSON.parse(readFileSync(join(dir, "keys.json"), "utf8"));

test("finds packages at the root, in subfolders, with several mods and with layouts", () => {
  const pkgs = core.findPackages([
    "README.md", "RECIPE.md", "preview.png", "keys.json",
    "mods/jump/main.js", "mods/jump/mod.json", "mods/jump/icon.svg", "mods/spaces-jump/main.js",
    "github-panel/RECIPE.md", "github-panel/mods/github/main.js", "github-panel/mods/issue/main.js",
    "board/layouts/board.json", "board/layouts/board.svg", "board/mods/board/main.js",
    "notes/mods/x/README.md",
  ]);
  assert.deepEqual(pkgs.map((p) => [p.prefix, p.name, p.mods, p.recipe, p.keys]), [
    ["", "jump + spaces-jump", ["jump", "spaces-jump"], true, true],
    ["board", "board", ["board"], false, false],
    ["github-panel", "github-panel", ["github", "issue"], true, false],
  ]);
  assert.deepEqual(pkgs[0].files, ["mods/jump/main.js", "mods/jump/mod.json", "mods/jump/icon.svg", "mods/spaces-jump/main.js"]);
  assert.deepEqual(pkgs[1].layouts, ["board/layouts/board.json", "board/layouts/board.svg"]);
});

test("flags programs, network and files in the sources", () => {
  const risks = core.scanRisks([
    { path: "a/main.js", text: "const r = await exec('git', ['status']); await fetch(url)" },
    { path: "b/main.js", text: "readTextFile(p); writeTextFile(p, t)" },
    { path: "c/main.js", text: "div().child('exec is a word'); cx.spawn(async () => refresh())" },
  ]);
  assert.deepEqual(risks, [
    { label: "runs programs", paths: ["a/main.js"] },
    { label: "reaches the network", paths: ["a/main.js"] },
    { label: "reads files", paths: ["b/main.js"] },
    { label: "writes files", paths: ["b/main.js"] },
  ]);
});

test("installs, keeps the person's keys, checks, updates and uninstalls a package", async () => {
  const src = repo({
    "RECIPE.md": "# x",
    "keys.json": JSON.stringify({ global: { "cmd-j": "jump.open", "cmd-p": "mod.open:jump" } }),
    "mods/jump/main.js": "exec('ls')",
    "mods/jump/mod.json": "{}",
  });
  const app = home();
  const cache = join(app, ".cache");
  let fetched = await core.fetchSource(io, src.dir, cache);
  let [pkg] = core.findPackages(fetched.files);
  const list = async (records) => (await core.listMods(io, { appHome: app, records })).map((m) => m.name);
  let plan = await core.planInstall(io, { appHome: app, dir: fetched.dir, pkg, record: null, existingMods: await list([]), existingLayouts: await core.listLayoutFiles(io, app) });
  assert.deepEqual(plan.clashes, []);
  assert.deepEqual(plan.keyAdds, [{ section: "global", key: "cmd-j", action: "jump.open" }]);
  assert.deepEqual(plan.keyConflicts, [{ section: "global", key: "cmd-p", action: "mod.open:jump", current: "mod.open:picker" }]);
  assert.deepEqual(plan.risks.map((r) => r.label), ["runs programs"]);

  let record = await core.applyInstall(io, { appHome: app, plan, source: src.dir, prefix: pkg.prefix, sha: fetched.sha, description: "jumps" });
  assert.equal(readFileSync(join(app, "mods/jump/main.js"), "utf8"), "exec('ls')");
  assert.deepEqual(keys(app).global, { "cmd-p": "mod.open:picker", "cmd-j": "jump.open" });
  assert.deepEqual(record.keys, [{ section: "global", key: "cmd-j", action: "jump.open" }]);
  assert.deepEqual(record.risks, ["runs programs"], "the approved risks are kept, so a bulk update can spot new ones");
  assert.equal(record.description, "jumps");
  assert.deepEqual(await core.checkMods(io, app, record.mods), []);
  const mods = await core.listMods(io, { appHome: app, records: [record] });
  assert.deepEqual(mods.map((m) => [m.name, m.kind]), [["jump", "installed"], ["mine", "local"], ["agents", "herdr"], ["picker", "herdr"]]);
  assert.equal(mods.find((m) => m.name === "mine").title, "Mine");

  src.commit({ "mods/jump/main.js": "v2", "keys.json": JSON.stringify({ global: { "cmd-j": "jump.toggle" } }) });
  assert.notEqual(await core.remoteSha(io, src.dir), record.sha);
  fetched = await core.fetchSource(io, src.dir, cache);
  [pkg] = core.findPackages(fetched.files);
  plan = await core.planInstall(io, { appHome: app, dir: fetched.dir, pkg, record, existingMods: await list([record]), existingLayouts: [] });
  assert.deepEqual(plan.clashes, [], "an update is not a clash with itself");
  assert.deepEqual(plan.keyAdds, [{ section: "global", key: "cmd-j", action: "jump.toggle" }], "its own untouched key follows the package");
  record = await core.applyInstall(io, { appHome: app, plan, source: src.dir, prefix: pkg.prefix, sha: fetched.sha, record });
  assert.equal(readFileSync(join(app, "mods/jump/main.js"), "utf8"), "v2");
  assert.equal(keys(app).global["cmd-j"], "jump.toggle");
  assert.equal(record.description, "jumps", "an update keeps the description");

  await core.uninstall(io, { appHome: app, record });
  assert.ok(!existsSync(join(app, "mods/jump")));
  assert.deepEqual(keys(app).global, { "cmd-p": "mod.open:picker" });
  assert.ok(existsSync(join(app, "mods/mine/main.js")), "other mods stay");
});

test("an update never takes back a key the person rebound", async () => {
  const src = repo({ "keys.json": JSON.stringify({ global: { "cmd-j": "jump.open" } }), "mods/jump/main.js": "" });
  const app = home({ global: { "cmd-j": "my.thing" } });
  const record = { source: src.dir, prefix: "", sha: "old", mods: ["jump"], layouts: [], keys: [{ section: "global", key: "cmd-j", action: "jump.open" }] };
  put(app, { "mods/jump/main.js": "" });
  const fetched = await core.fetchSource(io, src.dir, join(app, ".cache"));
  const [pkg] = core.findPackages(fetched.files);
  const plan = await core.planInstall(io, { appHome: app, dir: fetched.dir, pkg, record, existingMods: ["jump"], existingLayouts: [] });
  assert.deepEqual(plan.keyAdds, []);
  assert.equal(plan.keyConflicts[0].current, "my.thing");
  await core.uninstall(io, { appHome: app, record });
  assert.equal(keys(app).global["cmd-j"], "my.thing", "uninstall keeps a rebound key");
});

test("never overwrites a mod or layout it did not install", async () => {
  const src = repo({ "mods/mine/main.js": "theirs", "layouts/main.json": "{\"x\":1}" });
  const app = home();
  const fetched = await core.fetchSource(io, src.dir, join(app, ".cache"));
  const [pkg] = core.findPackages(fetched.files);
  const plan = await core.planInstall(io, { appHome: app, dir: fetched.dir, pkg, record: null, existingMods: ["mine"], existingLayouts: ["main.json"] });
  assert.deepEqual(plan.clashes, ["mods/mine", "layouts/main.json"]);
  await assert.rejects(core.applyInstall(io, { appHome: app, plan, source: src.dir, prefix: "", sha: fetched.sha }), /already exists/);
  assert.equal(readFileSync(join(app, "mods/mine/main.js"), "utf8"), "");
});

test("installs a package from a subfolder with its layout", async () => {
  const src = repo({ "board/RECIPE.md": "", "board/mods/board/main.js": "b", "board/layouts/board.json": "{}", "other/mods/o/main.js": "" });
  const app = home();
  const fetched = await core.fetchSource(io, src.dir, join(app, ".cache"));
  const pkg = core.findPackages(fetched.files).find((p) => p.prefix === "board");
  const plan = await core.planInstall(io, { appHome: app, dir: fetched.dir, pkg, record: null, existingMods: [], existingLayouts: [] });
  const record = await core.applyInstall(io, { appHome: app, plan, source: src.dir, prefix: "board", sha: fetched.sha });
  assert.deepEqual([record.mods, record.layouts], [["board"], ["board.json"]]);
  assert.ok(existsSync(join(app, "layouts/board.json")));
  assert.ok(!existsSync(join(app, "mods/o")), "only the chosen package");
});

test("reports a mod that fails herdr-app check, and a missing herdr-app", async () => {
  const app = home();
  assert.deepEqual(await core.checkMods(io, app, ["ok", "broken"]), [{ mod: "broken", error: "SyntaxError (test)" }]);
  const gone = { ...io, exec: async () => { throw new Error("not found"); } };
  assert.match((await core.checkMods(gone, app, ["x"]))[0].error, /couldn't run herdr-app check: not found/);
});

test("removing a local symlinked mod only unlinks it", async () => {
  const app = home();
  const target = mkdtempSync(join(tmpdir(), "km-target-"));
  put(target, { "main.js": "keep me" });
  symlinkSync(target, join(app, "mods/linked"));
  const mods = await core.listMods(io, { appHome: app, records: [] });
  assert.equal(mods.find((m) => m.name === "linked").symlink, true);
  assert.equal(mods.find((m) => m.name === "mine").symlink, false);
  await core.removeLocal(io, { appHome: app, name: "linked" });
  assert.throws(() => lstatSync(join(app, "mods/linked")));
  assert.equal(readFileSync(join(target, "main.js"), "utf8"), "keep me");
});

test("disable moves a mod aside and enable brings it back; layouts and built-ins block it", async () => {
  const app = home();
  put(app, { "mods/free/main.js": "f", "mods/k-settings/main.js": "" });
  const find = async (name) => (await core.listMods(io, { appHome: app, records: [] })).find((m) => m.name === name);

  assert.equal(await core.disableBlocker(io, { appHome: app, mod: await find("free") }), null);
  assert.match(await core.disableBlocker(io, { appHome: app, mod: await find("mine") }), /Used by layout k-main/);
  assert.match(await core.disableBlocker(io, { appHome: app, mod: await find("agents") }), /Built-in/);
  assert.match(await core.disableBlocker(io, { appHome: app, mod: await find("k-settings") }), /itself/);
  assert.deepEqual(await core.layoutsUsing(io, app, "agents"), ["main"]);

  await core.disable(io, { appHome: app, name: "free" });
  assert.ok(!existsSync(join(app, "mods/free")));
  assert.equal(readFileSync(join(app, "mods-disabled/free/main.js"), "utf8"), "f");
  const off = await find("free");
  assert.deepEqual([off.kind, off.disabled], ["local", true]);

  put(app, { "mods/free/main.js": "other" });
  await assert.rejects(core.enable(io, { appHome: app, name: "free" }), /mods\/free already exists/);
  execFileSync("rm", ["-rf", join(app, "mods/free")]);
  await core.enable(io, { appHome: app, name: "free" });
  assert.equal(readFileSync(join(app, "mods/free/main.js"), "utf8"), "f");
  assert.equal((await find("free")).disabled, false);

  // A disabled installed mod is still removed by uninstall.
  await core.disable(io, { appHome: app, name: "free" });
  await core.uninstall(io, { appHome: app, record: { mods: ["free"], layouts: [], keys: [] } });
  assert.ok(!existsSync(join(app, "mods-disabled/free")));
});

test("the file layer lists links, copies, moves and cleans stale cache folders", async () => {
  const fs = core.fsOps(io);
  const dir = mkdtempSync(join(tmpdir(), "km-fs-"));
  put(dir, { "a/x.txt": "1", "b.txt": "2", ".hidden/y": "3", "it's here/z": "4" });
  symlinkSync(join(dir, "a"), join(dir, "link"));
  const entries = (await fs.list(dir)).sort((p, q) => p.name.localeCompare(q.name));
  assert.deepEqual(entries, [
    { name: ".hidden", dir: true, link: false },
    { name: "a", dir: true, link: false },
    { name: "b.txt", dir: false, link: false },
    { name: "it's here", dir: true, link: false },
    { name: "link", dir: true, link: true },
  ]);
  assert.deepEqual(await fs.list(join(dir, "missing")), []);
  await fs.copyDir(join(dir, "it's here"), join(dir, "copy"));
  assert.equal(readFileSync(join(dir, "copy/z"), "utf8"), "4");
  const old = Date.now() / 1000 - 7200;
  utimesSync(join(dir, "a"), old, old);
  await fs.rmrf(join(dir, "link"));
  await fs.cleanStale(dir);
  assert.ok(!existsSync(join(dir, "a")), "older than an hour goes");
  assert.ok(existsSync(join(dir, "copy/z")), "fresh stays");
  await fs.cleanStale(join(dir, "missing"));
});

test("Windows paths and commands: backslash joins, PowerShell with quoted literal paths", async () => {
  const calls = [];
  const win = {
    platform: "windows",
    async exec(cmd, args) {
      calls.push([cmd, ...args]);
      return { code: 0, stdout: "1\t0\tfoo\r\n1\t1\tlinked\r\n0\t0\tnotes.txt\r\n", stderr: "" };
    },
  };
  assert.equal(core.join(win, "C:\\Users\\k\\AppData\\herdr-app\\", "mods", "a/b.js"), "C:\\Users\\k\\AppData\\herdr-app\\mods\\a\\b.js");
  assert.equal(core.join(win, "C:\\x", ""), "C:\\x");
  assert.equal(core.join(io, "/h/", "/mods/", "x"), "/h/mods/x");
  assert.equal(core.baseName("C:\\a\\b"), "b");
  assert.equal(core.repoUrl("C:\\src\\repo"), "C:\\src\\repo");

  const fs = core.fsOps(win);
  assert.deepEqual(await fs.list("C:\\h\\mods"), [
    { name: "foo", dir: true, link: false }, { name: "linked", dir: true, link: true }, { name: "notes.txt", dir: false, link: false },
  ]);
  await fs.rmrf("C:\\h\\it's");
  await fs.move("C:\\h\\mods\\a", "C:\\h\\mods-disabled\\a");
  await fs.openUrl("https://github.com/a/b");
  await fs.cleanStale("C:\\h\\.k-mods-cache");
  for (const c of calls) {
    assert.deepEqual(c.slice(0, 4), ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
    assert.equal(c.length, 5, "the whole script is one argument");
    assert.ok(!c[4].includes('"'), "no double quotes for the Windows command line to mangle");
  }
  assert.match(calls[1][4], /Get-Item -LiteralPath \$p .*\$i\.LinkType\) \{ \$i\.Delete\(\) \}/);
  assert.match(calls[1][4], /\$p = 'C:\\h\\it''s'/);
  assert.match(calls[2][4], /Move-Item -LiteralPath 'C:\\h\\mods\\a' -Destination 'C:\\h\\mods-disabled\\a'/);
  assert.match(calls[3][4], /Start-Process 'https:\/\/github.com\/a\/b'/);
  assert.match(calls[4][4], /AddHours\(-1\).*\$p = \$_\.FullName/);
});

test("repoUrl maps owner/repo to GitHub and keeps URLs and paths", () => {
  assert.equal(core.repoUrl("dev-gvs/herdr-claude-usage"), "https://github.com/dev-gvs/herdr-claude-usage.git");
  assert.equal(core.repoUrl("/tmp/x"), "/tmp/x");
  assert.equal(core.repoUrl("https://example.com/x.git"), "https://example.com/x.git");
  assert.equal(core.repoPage("a/b"), "https://github.com/a/b");
  assert.equal(core.repoPage("/tmp/x"), null);
});

test("market search goes through gh, and anonymously when gh fails", async () => {
  const calls = [];
  const item = { full_name: "a/b", description: null, stargazers_count: 3, pushed_at: "2026-10-01T00:00:00Z", html_url: "https://github.com/a/b" };
  const viaGh = { exec: async (cmd, args) => { calls.push([cmd, ...args].join(" ")); return { code: 0, stdout: JSON.stringify({ total_count: 1500, items: [item] }), stderr: "" }; } };
  const r = await core.searchMarket(viaGh, { query: " jump ", sort: "updated", page: 2 }, () => assert.fail("no anonymous call"));
  assert.equal(r.total, 1000);
  assert.deepEqual(r.items, [{ fullName: "a/b", description: "", stars: 3, pushedAt: "2026-10-01T00:00:00Z", url: "https://github.com/a/b" }]);
  assert.match(calls[0], /-f q=topic:herdr-mod jump -f sort=updated .* -f page=2/);

  const noGh = { exec: async () => { throw new Error("gh not found"); } };
  let asked = null;
  const r2 = await core.searchMarket(noGh, {}, async (url) => { asked = url; return { status: 200, text: JSON.stringify({ total_count: 1, items: [item] }) }; });
  assert.equal(r2.items.length, 1);
  assert.match(asked, /q=topic%3Aherdr-mod&sort=stars/);
  await assert.rejects(
    core.searchMarket(noGh, {}, async () => ({ status: 403, text: JSON.stringify({ message: "API rate limit exceeded" }) })),
    /403: API rate limit exceeded \(gh: gh not found\)/,
  );
});

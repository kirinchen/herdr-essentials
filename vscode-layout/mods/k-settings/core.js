// k-settings Mods page (herdr-essentials, was k-mods): everything the manager does to files, with no dependency on the Herdr
// runtime. The view passes `io` ({ platform, exec, readText, writeText }) so the same code runs
// under `node --test` against real git.
//
// Derived from jacksonpires/herdr-app-mod-manager (MIT, (c) 2026 speardragon, (c) 2026 Jackson
// Pires; see LICENSE in this folder). Changes: English text, a platform file layer (PowerShell on
// Windows instead of find/ls/cp/rm/mkdir/open), enable/disable, layout-use checks.

export const MARKET_TOPIC = "herdr-mod";
export const SELF = "k-settings"; // the mod this manager lives in
export const DISABLED_DIR = "mods-disabled";

// ---------------------------------------------------------------------------------------------
// Paths. appHome() is a Windows path on Windows, while git and package listings use "/".

export const isWindows = (io) => io.platform === "windows";

export function join(io, ...parts) {
  const win = isWindows(io);
  const sep = win ? "\\" : "/";
  const out = [];
  parts.filter((p) => p !== "" && p != null).forEach((p, i) => {
    let s = String(p);
    if (win) s = s.replace(/\//g, "\\");
    s = i === 0 ? s.replace(/[\\/]+$/, "") : s.replace(/^[\\/]+|[\\/]+$/g, "");
    if (s || i === 0) out.push(s);
  });
  return out.join(sep);
}

export const baseName = (p) => String(p).split(/[\\/]/).filter(Boolean).at(-1) ?? "";

// ---------------------------------------------------------------------------------------------
// The platform file layer: PowerShell on Windows, sh with positional arguments elsewhere, so no
// path is ever spliced into a shell string unquoted.

const psq = (s) => `'${String(s).replace(/'/g, "''")}'`;

async function run(io, cmd, args, opts, label) {
  const r = await io.exec(cmd, args, opts);
  if (r.code !== 0) throw new Error(`${label ?? `${cmd} ${args[0] ?? ""}`}: ${(r.stderr || r.stdout).trim()}`);
  return r.stdout;
}

const ps = (io, label, script, opts) => run(io, "powershell.exe", ["-NoProfile", "-NonInteractive", "-Command",
  `$ErrorActionPreference='Stop'; try { [Console]::OutputEncoding=[Text.Encoding]::UTF8 } catch {}; ${script}`], opts, label);
const sh = (io, label, script, args, opts) => run(io, "sh", ["-c", script, "sh", ...args], opts, label);

// Windows: a link (symlink or junction) is deleted as a link, never followed into its target.
// `expr` is a PowerShell expression for the path (a quoted literal, or `$_.FullName` in a pipeline).
const psRemoveExpr = (expr) => `$p = ${expr}; $i = Get-Item -LiteralPath $p -Force -ErrorAction SilentlyContinue; ` +
  `if ($i) { if ($i.LinkType) { $i.Delete() } else { Remove-Item -LiteralPath $p -Recurse -Force } }`;
const psRemove = (p) => psRemoveExpr(psq(p));

export function fsOps(io) {
  if (isWindows(io)) {
    return {
      mkdirp: (...paths) => ps(io, "mkdir", paths.map((p) => `[void][IO.Directory]::CreateDirectory(${psq(p)})`).join("; ")),
      rmrf: (p) => ps(io, "remove", psRemove(p)),
      rmFile: (p) => ps(io, "remove", `if (Test-Path -LiteralPath ${psq(p)}) { Remove-Item -LiteralPath ${psq(p)} -Force }`),
      copyDir: (src, dst) => ps(io, "copy", `Copy-Item -LiteralPath ${psq(src)} -Destination ${psq(dst)} -Recurse -Force`),
      copyFile: (src, dst) => ps(io, "copy", `Copy-Item -LiteralPath ${psq(src)} -Destination ${psq(dst)} -Force`),
      move: (src, dst) => ps(io, "move", `Move-Item -LiteralPath ${psq(src)} -Destination ${psq(dst)}`),
      async list(dir) {
        const out = await ps(io, "list", `if (Test-Path -LiteralPath ${psq(dir)}) { Get-ChildItem -LiteralPath ${psq(dir)} -Force | ` +
          `ForEach-Object { ([int]$_.PSIsContainer).ToString() + [char]9 + ([int][bool]$_.LinkType).ToString() + [char]9 + $_.Name } }`);
        return parseList(out);
      },
      openUrl: (url) => ps(io, "open", `Start-Process ${psq(url)}`),
      cleanStale: (dir) => ps(io, "clean", `if (Test-Path -LiteralPath ${psq(dir)}) { Get-ChildItem -LiteralPath ${psq(dir)} -Force | ` +
        `Where-Object { $_.LastWriteTime -lt (Get-Date).AddHours(-1) } | ForEach-Object { ${psRemoveExpr("$_.FullName")} } }`),
    };
  }
  return {
    mkdirp: (...paths) => sh(io, "mkdir", 'mkdir -p -- "$@"', paths),
    rmrf: (p) => sh(io, "remove", 'rm -rf -- "$1"', [p]),
    rmFile: (p) => sh(io, "remove", 'rm -f -- "$1"', [p]),
    copyDir: (src, dst) => sh(io, "copy", 'cp -R -- "$1" "$2"', [src, dst]),
    copyFile: (src, dst) => sh(io, "copy", 'cp -- "$1" "$2"', [src, dst]),
    move: (src, dst) => sh(io, "move", 'mv -- "$1" "$2"', [src, dst]),
    async list(dir) {
      const out = await sh(io, "list", `cd "$1" 2>/dev/null || exit 0
for f in * .*; do
  case $f in .|..) continue;; esac
  [ -e "$f" ] || [ -L "$f" ] || continue
  d=0; [ -d "$f" ] && d=1; l=0; [ -L "$f" ] && l=1
  printf '%s\\t%s\\t%s\\n' "$d" "$l" "$f"
done`, [dir]);
      return parseList(out);
    },
    openUrl: (url) => io.platform === "macos"
      ? run(io, "open", [url], undefined, "open")
      : sh(io, "open", 'xdg-open "$1" >/dev/null 2>&1 </dev/null &', [url]),
    cleanStale: (dir) => sh(io, "clean", '[ -d "$1" ] || exit 0; find "$1" -mindepth 1 -maxdepth 1 -mmin +60 -exec rm -rf {} +', [dir]),
  };
}

function parseList(out) {
  return out.split(/\r?\n/).filter(Boolean).map((line) => {
    const [d, l, ...rest] = line.split("\t");
    return { name: rest.join("\t"), dir: d === "1", link: l === "1" };
  }).filter((e) => e.name);
}

// ---------------------------------------------------------------------------------------------
// Packages and the review.

// A package is any folder of a repo that holds `mods/<name>/main.js`: the repo root, or one
// folder per package when a repo holds several (`github-panel/mods/github/…`).
export function findPackages(files) {
  const byPrefix = new Map();
  for (const f of files) {
    const m = f.match(/^(?:(.*)\/)?mods\/([^/]+)\/main\.js$/);
    if (!m) continue;
    const prefix = m[1] ?? "";
    if (!byPrefix.has(prefix)) byPrefix.set(prefix, { prefix, mods: [], layouts: [], files: [] });
    byPrefix.get(prefix).mods.push(m[2]);
  }
  for (const pkg of byPrefix.values()) {
    const base = pkg.prefix ? `${pkg.prefix}/` : "";
    pkg.mods.sort();
    pkg.files = files.filter((f) => pkg.mods.some((name) => f.startsWith(`${base}mods/${name}/`)));
    pkg.layouts = files.filter((f) => f.startsWith(`${base}layouts/`) && !f.slice(base.length + 8).includes("/"));
    pkg.recipe = files.includes(`${base}RECIPE.md`);
    pkg.preview = files.includes(`${base}preview.png`);
    pkg.keys = files.includes(`${base}keys.json`);
    pkg.name = pkg.prefix ? pkg.prefix.split("/").at(-1) : pkg.mods.join(" + ");
  }
  return [...byPrefix.values()].sort((a, b) => a.prefix.localeCompare(b.prefix));
}

// Whether a mod runs programs, reaches the network or touches files. A pattern match on the
// source, so it can only over-report.
const RISKS = [
  ["runs programs", /\bexec\s*\(|\bhc\s*\(|process\.run/],
  ["reaches the network", /\bfetch\s*\(|WebSocket/],
  ["reads files", /readTextFile\s*\(|watchFolder\s*\(|fs\.(readFile|readdir|stat)/],
  ["writes files", /writeTextFile\s*\(|fs\.(writeFile|mkdir|rm|unlink|rename)/],
];

export function scanRisks(sources) {
  const found = new Map();
  for (const { path, text } of sources) {
    for (const [label, re] of RISKS) {
      if (re.test(text)) {
        if (!found.has(label)) found.set(label, []);
        found.get(label).push(path);
      }
    }
  }
  return [...found].map(([label, paths]) => ({ label, paths }));
}

export function repoUrl(fullName) {
  return /^(https?|file|git):|^\/|^[A-Za-z]:[\\/]/.test(fullName) ? fullName : `https://github.com/${fullName}.git`;
}

export const repoPage = (source) => (/^[\w.-]+\/[\w.-]+$/.test(source ?? "") ? `https://github.com/${source}` : null);

// Shallow clone into a fresh folder under `cacheDir`; returns the folder, commit and tracked files.
export async function fetchSource(io, source, cacheDir) {
  const dir = join(io, cacheDir, `${source.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+/, "")}-${Date.now()}`);
  await fsOps(io).mkdirp(cacheDir);
  await run(io, "git", ["clone", "-q", "--depth", "1", repoUrl(source), dir], { timeout: 180000 }, "git clone");
  const sha = (await run(io, "git", ["-C", dir, "rev-parse", "HEAD"], undefined, "git rev-parse")).trim();
  const files = (await run(io, "git", ["-C", dir, "ls-files"], undefined, "git ls-files")).split(/\r?\n/).filter(Boolean);
  return { dir, sha, files };
}

export async function remoteSha(io, source) {
  const out = await run(io, "git", ["ls-remote", repoUrl(source), "HEAD"], { timeout: 30000 }, "git ls-remote");
  return out.split(/\s/)[0] || null;
}

export async function readSources(io, dir, pkg) {
  const texts = [];
  for (const path of pkg.files.filter((f) => /\.(m?js|json)$/.test(f))) {
    texts.push({ path, text: (await io.readText(join(io, dir, path))) ?? "" });
  }
  return texts;
}

function parseJson(text) {
  if (!text) return {};
  const v = JSON.parse(text);
  return v && typeof v === "object" ? v : {};
}

// What installing `pkg` would do, without doing it. `record` is the earlier install of the same
// package (an update): its own mods and layouts are replaced, anything else with the same name is
// a clash and blocks the install. Nothing is ever overwritten.
export async function planInstall(io, { appHome, dir, pkg, record, existingMods, existingLayouts }) {
  const base = join(io, dir, pkg.prefix);
  const ownMods = new Set(record?.mods ?? []);
  const ownLayouts = new Set(record?.layouts ?? []);
  const layouts = pkg.layouts.map((f) => f.split("/").at(-1));
  const clashes = [
    ...pkg.mods.filter((m) => existingMods.includes(m) && !ownMods.has(m)).map((m) => `mods/${m}`),
    ...layouts.filter((l) => existingLayouts.includes(l) && !ownLayouts.has(l)).map((l) => `layouts/${l}`),
  ];
  const theirs = pkg.keys ? parseJson(await io.readText(join(io, base, "keys.json"))) : {};
  const mine = parseJson(await io.readText(join(io, appHome, "keys.json")));
  // A key the package added earlier and the person left alone is the package's to change.
  const ownKeys = new Map((record?.keys ?? []).map((k) => [`${k.section}\u0000${k.key}`, k.action]));
  const keyAdds = [];
  const keyConflicts = [];
  for (const [section, entries] of Object.entries(theirs)) {
    for (const [key, action] of Object.entries(entries ?? {})) {
      const current = mine[section]?.[key];
      const own = ownKeys.get(`${section}\u0000${key}`);
      if (current === undefined || current === action || (own !== undefined && current === own)) {
        if (current !== action) keyAdds.push({ section, key, action });
      } else {
        keyConflicts.push({ section, key, action, current });
      }
    }
  }
  return { base, mods: pkg.mods, layouts, clashes, keyAdds, keyConflicts, risks: scanRisks(await readSources(io, dir, pkg)) };
}

async function writeKeys(io, appHome, change) {
  const path = join(io, appHome, "keys.json");
  const keys = parseJson(await io.readText(path));
  change(keys);
  await io.writeText(path, JSON.stringify(keys, null, 2) + "\n");
}

// Copies the package and adds its keys. Conflicting keys are left as the person has them. On an
// update, the package's previous folders are removed first, and only those.
export async function applyInstall(io, { appHome, plan, source, prefix, sha, record, description }) {
  if (plan.clashes.length) throw new Error(`already exists: ${plan.clashes.join(", ")}`);
  const fs = fsOps(io);
  for (const m of record?.mods ?? []) await fs.rmrf(join(io, appHome, "mods", m));
  for (const l of record?.layouts ?? []) await fs.rmFile(join(io, appHome, "layouts", l));
  await fs.mkdirp(join(io, appHome, "mods"), join(io, appHome, "layouts"));
  for (const m of plan.mods) await fs.copyDir(join(io, plan.base, "mods", m), join(io, appHome, "mods", m));
  for (const l of plan.layouts) await fs.copyFile(join(io, plan.base, "layouts", l), join(io, appHome, "layouts", l));
  const keys = [...(record?.keys ?? []).filter((k) => !plan.keyConflicts.some((c) => c.section === k.section && c.key === k.key)), ...plan.keyAdds];
  if (plan.keyAdds.length) {
    await writeKeys(io, appHome, (all) => {
      for (const k of plan.keyAdds) (all[k.section] ??= {})[k.key] = k.action;
    });
  }
  return {
    source, prefix, sha, mods: plan.mods, layouts: plan.layouts, keys: dedupeKeys(keys),
    risks: plan.risks.map((r) => r.label), description: description ?? record?.description ?? "", at: new Date().toISOString(),
  };
}

function dedupeKeys(keys) {
  const seen = new Map();
  for (const k of keys) seen.set(`${k.section}\u0000${k.key}`, k);
  return [...seen.values()];
}

export async function checkMods(io, appHome, mods) {
  const failures = [];
  for (const m of mods) {
    try {
      const r = await io.exec("herdr-app", ["check", join(io, appHome, "mods", m)], { timeout: 60000 });
      if (r.code !== 0) failures.push({ mod: m, error: (r.stderr || r.stdout).trim() });
    } catch (e) {
      failures.push({ mod: m, error: `couldn't run herdr-app check: ${e?.message ?? e}` });
    }
  }
  return failures;
}

// Removes what the record says the manager installed (enabled or disabled). A key is removed only
// while it still runs the action the package added: one the person rebound since then stays.
export async function uninstall(io, { appHome, record }) {
  const fs = fsOps(io);
  for (const m of record.mods) {
    await fs.rmrf(join(io, appHome, "mods", m));
    await fs.rmrf(join(io, appHome, DISABLED_DIR, m));
  }
  for (const l of record.layouts ?? []) await fs.rmFile(join(io, appHome, "layouts", l));
  if (record.keys?.length) {
    await writeKeys(io, appHome, (all) => {
      for (const k of record.keys) {
        if (all[k.section]?.[k.key] === k.action) delete all[k.section][k.key];
      }
    });
  }
}

// A mod the manager did not install: a symlink is only unlinked, the folder it points to stays.
export async function removeLocal(io, { appHome, name, disabled }) {
  await fsOps(io).rmrf(join(io, appHome, disabled ? DISABLED_DIR : "mods", name));
}

// ---------------------------------------------------------------------------------------------
// The mods folder, the disabled folder, and which layouts use what.

const visible = (e) => (e.dir || e.link) && !e.name.startsWith(".");

export async function listMods(io, { appHome, records }) {
  const fs = fsOps(io);
  const shipped = Object.keys(parseJson(await io.readText(join(io, appHome, "installed.json"))));
  const active = (await fs.list(join(io, appHome, "mods"))).filter(visible);
  const disabled = (await fs.list(join(io, appHome, DISABLED_DIR))).filter(visible);
  const owner = new Map();
  for (const r of records) for (const m of r.mods) owner.set(m, r);
  const entries = [
    ...active.map((e) => ({ ...e, disabled: false })),
    ...disabled.filter((e) => !active.some((a) => a.name === e.name)).map((e) => ({ ...e, disabled: true })),
  ];
  const out = [];
  for (const e of entries) {
    let meta = {};
    try { meta = parseJson(await io.readText(join(io, appHome, e.disabled ? DISABLED_DIR : "mods", e.name, "mod.json"))); } catch {}
    out.push({
      name: e.name,
      kind: owner.has(e.name) ? "installed" : shipped.includes(e.name) ? "herdr" : "local",
      symlink: e.link,
      disabled: e.disabled,
      record: owner.get(e.name) ?? null,
      title: typeof meta.title === "string" ? meta.title : "",
      description: typeof meta.description === "string" ? meta.description : "",
    });
  }
  return out.sort((a, b) => (a.kind === "herdr") - (b.kind === "herdr") || a.name.localeCompare(b.name));
}

export async function listLayoutFiles(io, appHome) {
  return (await fsOps(io).list(join(io, appHome, "layouts"))).filter((e) => !e.dir).map((e) => e.name);
}

function mentions(node, name) {
  if (Array.isArray(node)) return node.some((n) => mentions(n, name));
  if (node && typeof node === "object") {
    if (node.mod === name) return true;
    return Object.values(node).some((v) => mentions(v, name));
  }
  return false;
}

// Layouts (by name, without .json) with a `"mod": "<name>"` anywhere in them.
export async function layoutsUsing(io, appHome, name) {
  const used = [];
  for (const file of (await listLayoutFiles(io, appHome)).filter((f) => f.endsWith(".json")).sort()) {
    const text = await io.readText(join(io, appHome, "layouts", file));
    if (!text) continue;
    let hit;
    try { hit = mentions(JSON.parse(text), name); }
    catch { hit = new RegExp(`"mod"\\s*:\\s*"${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`).test(text); }
    if (hit) used.push(file.replace(/\.json$/, ""));
  }
  return used;
}

// Why `mod` can't be disabled, or null when it can.
export async function disableBlocker(io, { appHome, mod }) {
  if (mod.kind === "herdr") return "Built-in Herdr mods can't be disabled.";
  if (mod.name === SELF) return "The mod manager (k-settings) can't disable itself.";
  const used = await layoutsUsing(io, appHome, mod.name);
  if (used.length) return `Used by layout${used.length > 1 ? "s" : ""} ${used.join(", ")}; switch those layouts off it first.`;
  return null;
}

// Disabling moves mods/<name> to mods-disabled/<name>; enabling moves it back.
export async function disable(io, { appHome, name }) {
  const fs = fsOps(io);
  const dir = join(io, appHome, DISABLED_DIR);
  await fs.mkdirp(dir);
  if ((await fs.list(dir)).some((e) => e.name === name)) throw new Error(`${DISABLED_DIR}/${name} already exists`);
  await fs.move(join(io, appHome, "mods", name), join(io, dir, name));
}

export async function enable(io, { appHome, name }) {
  const fs = fsOps(io);
  if ((await fs.list(join(io, appHome, "mods"))).some((e) => e.name === name)) throw new Error(`mods/${name} already exists`);
  await fs.move(join(io, appHome, DISABLED_DIR, name), join(io, appHome, "mods", name));
}

// ---------------------------------------------------------------------------------------------
// Marketplace: GitHub search for the topic. `gh api` carries the person's login (30 searches a
// minute instead of 10); without `gh`, `anonymous(url)` fetches the same URL.

export async function searchMarket(io, { query = "", sort = "stars", page = 1, perPage = 50 }, anonymous) {
  const q = `topic:${MARKET_TOPIC}${query.trim() ? ` ${query.trim()}` : ""}`;
  const params = { q, sort, order: "desc", per_page: String(perPage), page: String(page) };
  let body = null;
  let ghError = null;
  try {
    const args = ["api", "-X", "GET", "search/repositories"];
    for (const [k, v] of Object.entries(params)) args.push("-f", `${k}=${v}`);
    const r = await io.exec("gh", args, { timeout: 30000 });
    if (r.code === 0) body = JSON.parse(r.stdout);
    else ghError = (r.stderr || r.stdout).trim();
  } catch (e) {
    ghError = String(e?.message ?? e);
  }
  if (!body) {
    const url = `https://api.github.com/search/repositories?${new URLSearchParams(params)}`;
    const res = await anonymous(url);
    if (res.status !== 200) {
      const msg = (() => { try { return JSON.parse(res.text).message; } catch { return res.text.slice(0, 120); } })();
      throw new Error(`GitHub answered ${res.status}: ${msg}${ghError ? ` (gh: ${ghError})` : ""}`);
    }
    body = JSON.parse(res.text);
  }
  return {
    total: Math.min(body.total_count ?? 0, 1000),
    items: (body.items ?? []).map((r) => ({
      fullName: r.full_name,
      description: r.description ?? "",
      stars: r.stargazers_count ?? 0,
      pushedAt: r.pushed_at,
      url: r.html_url,
    })),
  };
}

// k-spaces (herdr-essentials): the menu behind a machine's "+". Lists the GitHub repos that
// machine's `gh` can see (yours, your orgs', collaborations), marks the ones already cloned there,
// and opens a space in a clone, cloning it first into that machine's repo folder when needed.
// The repo folder starts as a guess (the usual places, most repos wins), so clones already there
// are found from the first open; it's always shown above the list, and Choose changes it (the
// system folder dialog here; for a remote machine, whose disks that dialog can't see, a folder
// browser in this menu that lists that machine's folders, which can also open a space there).
// "Open a folder…" opens a space on any folder, picked the same two ways (no repo, no typing a path).
// "New empty space" is the plain space.new it replaced.
//
// Everything runs on the chosen machine (exec `on`), so its gh login and folders are the ones used.
// Kept per machine in shared("k-spaces.repos"): { base: default clone folder, clones: { "owner/name": path } }.
// A clone is also found by looking two levels under `base` for .git folders and their origin.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { exec, run, spaces, shared, setShared, theme, props, closeOverlay, notify, window } from "herdr";

const KEY = "k-spaces.repos";
const store = () => { const s = shared(KEY); return s && typeof s === "object" && !Array.isArray(s) ? s : {}; };
const saveFor = (mk, patch) => { const s = store(); setShared(KEY, { ...s, [mk]: { ...(s[mk] ?? {}), ...patch } }); };

// "owner/name" from a GitHub remote (https or ssh), lower-cased; null for anything else.
function slugOf(url) {
  const m = /github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i.exec(String(url ?? "").trim());
  return m ? `${m[1]}/${m[2]}`.toLowerCase() : null;
}
const sameDir = (a, b) => String(a ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase() === String(b ?? "").replace(/[\\/]+$/, "").replace(/\\/g, "/").toLowerCase();
// The system's folder dialog on this computer (as k-tabs' Attach does files): a path, or "" when cancelled.
async function pickFolder(platform, start, title = "Folder you keep repos in") {
  const q = title.replace(/['"]/g, "");
  const long = { timeout: 600000 };
  const out = (r) => (r.code === 0 ? (r.stdout ?? "").trim() : "");
  if (platform === "windows") {
    const ps = [
      "Add-Type -AssemblyName System.Windows.Forms",
      "[Console]::OutputEncoding = [Text.Encoding]::UTF8",
      "$o = New-Object System.Windows.Forms.Form -Property @{ TopMost = $true; ShowInTaskbar = $false }",
      `$d = New-Object System.Windows.Forms.FolderBrowserDialog -Property @{ Description = '${q}'; ShowNewFolderButton = $true }`,
      `$d.SelectedPath = '${String(start).replace(/'/g, "''")}'`,
      "if ($d.ShowDialog($o) -eq 'OK') { [Console]::Out.Write($d.SelectedPath) }",
    ].join("; ");
    return out(await exec("powershell.exe", ["-NoProfile", "-STA", "-Command", ps], long));
  }
  if (platform === "macos")
    return out(await exec("osascript", ["-e", `POSIX path of (choose folder with prompt "${q}")`], long)).replace(/\/$/, "");
  try { return out(await exec("zenity", ["--file-selection", "--directory", `--title=${q}`, ...(start ? [`--filename=${start}/`] : [])], long)); }
  catch { return out(await exec("kdialog", ["--getexistingdirectory", start || "."], long)); }
}

const ago = (iso) => {
  const d = (Date.now() - Date.parse(iso)) / 86400000;
  return !isFinite(d) ? "" : d < 1 ? "today" : d < 30 ? `${Math.floor(d)}d` : d < 365 ? `${Math.floor(d / 30)}mo` : `${Math.floor(d / 365)}y`;
};

export default class RepoMenu extends View {
  init(p, cx) {
    this.machine = p?.machine ?? null;               // null: this computer
    this.mk = this.machine ?? "";                    // its key in the store
    this.on = this.machine ? { on: this.machine } : {};
    this.sys = null;                                 // { posix, home, sep } of that machine
    this.repos = null;                               // [{ slug, full, name, private, pushed }]
    this.found = {};                                 // slug -> clone path seen under base
    this.error = null;
    this.query = "";
    this.picked = null;                              // a repo waiting for "Clone"
    this.busy = null;
    this.browse = null;                              // remote folder browser: { path, dirs, error, busy }
    this.choosing = false;                           // the folder dialog is up (this computer)
    this.search = InputState.new({ placeholder: "Search repos" });
    this.search.on("change", (_e, cx) => { this.query = this.search.value().trim().toLowerCase(); cx.notify(); });
    this.search.on("submit", (_e, cx) => { const first = this.list()[0]; if (first) this.choose(first, cx); });
    this.baseInput = InputState.new({ placeholder: "Folder you keep repos in" });
    this.baseInput.on("submit", (_e, cx) => this.setBase(cx));
    // The browser's path: Enter goes there.
    this.browseInput = InputState.new({ placeholder: "Folder path" });
    this.browseInput.on("submit", (_e, cx) => this.goTo(this.browseInput.value().trim(), cx));
    cx.timer.after(60, () => this.search.focus());
    cx.spawn(async (cx) => this.load(cx));
  }

  async run(cmd, args, timeout) {
    return exec(cmd, args, { ...this.on, ...(timeout ? { timeout } : {}) });
  }

  // Which shell that machine has, and its home: a remote one may be Windows too.
  async system() {
    if (this.sys) return this.sys;
    const local = !this.machine;
    let posix = local ? window()?.platform !== "windows" : false;
    if (!local) { try { posix = (await this.run("sh", ["-c", "uname"])).code === 0; } catch { posix = false; } }
    let home = "";
    try {
      const r = posix ? await this.run("sh", ["-c", 'printf %s "$HOME"']) : await this.run("powershell.exe", ["-NoProfile", "-Command", "[Console]::Out.Write($env:USERPROFILE)"]);
      home = (r.stdout ?? "").trim();
    } catch {}
    this.sys = { posix, home, sep: posix ? "/" : "\\" };
    return this.sys;
  }

  base() { return store()[this.mk]?.base ?? null; }
  clones() { return store()[this.mk]?.clones ?? {}; }
  where(repo) { return this.clones()[repo.slug] ?? this.found[repo.slug] ?? null; }

  async load(cx) {
    try {
      await this.system();
      // The first time, the guess is the repo folder (shown above the list, Choose changes it).
      if (!this.base()) { const g = await this.guess(); if (g) saveFor(this.mk, { base: g }); }
      this.baseInput.set_value(this.base() ?? "");
      cx.notify();
      await Promise.all([this.loadRepos(), this.scan(), this.prune()]);
    } catch (e) { this.error = String(e?.message ?? e); }
    cx.notify();
  }

  // Yours, your organizations' and ones you collaborate on, newest push first.
  async loadRepos() {
    let r;
    try {
      r = await this.run("gh", ["api", "--paginate", "user/repos?per_page=100&sort=pushed&affiliation=owner,organization_member,collaborator",
        "--jq", ".[] | [.full_name, .name, (.private|tostring), .pushed_at] | @tsv"], 60000);
    } catch { this.error = `gh isn't installed on ${this.machine ?? "this computer"}.`; this.repos = []; return; }
    if (r.code !== 0) {
      const msg = `${r.stderr ?? ""}${r.stdout ?? ""}`;
      this.error = /auth login|not logged|authentication/i.test(msg)
        ? `${this.machine ?? "This computer"} isn't logged in to GitHub: run gh auth login there.`
        : msg.trim().slice(0, 200) || "gh failed";
      this.repos = [];
      return;
    }
    const seen = new Set();
    this.repos = (r.stdout ?? "").split(/\r?\n/).filter(Boolean).map((line) => {
      const [full, name, priv, pushed] = line.split("\t");
      return { slug: full.toLowerCase(), full, name, private: priv === "true", pushed };
    }).filter((x) => !seen.has(x.slug) && seen.add(x.slug))
      .sort((a, b) => String(b.pushed).localeCompare(String(a.pushed)));
  }

  // Where repos probably live: the usual places, the one with the most git repos (default ~/projects).
  async guess() {
    const sys = await this.system();
    if (!sys.home) return "";
    const names = ["projects", "Desktop/projects", "code", "src", "workspace", "repos", "git", "dev", "Documents/GitHub"];
    const dirs = names.map((n) => `${sys.home}${sys.sep}${n.split("/").join(sys.sep)}`);
    let r;
    try {
      r = sys.posix
        ? await this.run("sh", ["-c", 'for d in "$@"; do n=0; for g in "$d"/*/.git; do [ -e "$g" ] && n=$((n+1)); done; printf "%s\\t%s\\n" "$n" "$d"; done', "sh", ...dirs])
        : await this.run("powershell.exe", ["-NoProfile", "-Command",
          `foreach ($d in @(${dirs.map((d) => `'${d.replace(/'/g, "''")}'`).join(",")})) { $n = 0; if (Test-Path -LiteralPath $d) { $n = @(Get-ChildItem -LiteralPath $d -Directory -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.git') }).Count }; "$n\`t$d" }`]);
    } catch { return dirs[0]; }
    let best = null;
    for (const line of (r.stdout ?? "").split(/\r?\n/)) {
      const [n, d] = line.split("\t");
      if (d && +n > 0 && (!best || +n > best.n)) best = { n: +n, d: d.trim() };
    }
    return best?.d ?? dirs[0];
  }

  // Choose: the system folder dialog on this computer. A remote machine's folders aren't on this
  // screen's dialog, so there the folder is typed (the field opens instead).
  choose_base(cx) {
    if (this.machine) {
      if (this.browse) { this.browse = null; cx.notify(); return; }
      cx.spawn(async (cx) => { const sys = await this.system(); this.goTo(this.base() || sys.home, cx); });
      return;
    }
    if (this.choosing) return;
    this.choosing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const dir = await pickFolder(window()?.platform, this.base() ?? "");
        if (dir) { this.baseInput.set_value(dir); this.setBase(cx); }
      } catch (e) { this.error = `Couldn't open the folder dialog: ${String(e?.message ?? e)}`; }
      this.choosing = false;
      cx.notify();
    });
  }

  // Open a folder…: a space on any folder, picked in the system's folder dialog (this computer) or in
  // the folder browser here (another machine: "Open a space here").
  open_folder(cx) {
    if (this.machine) {
      if (this.browse) { this.browse = null; cx.notify(); return; }
      cx.spawn(async (cx) => { const sys = await this.system(); this.goTo(this.base() || sys.home, cx); });
      return;
    }
    if (this.choosing) return;
    this.choosing = true;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const sys = await this.system();
        const dir = await pickFolder(window()?.platform, this.base() || sys.home || "", "Folder to open as a space");
        if (dir) { this.open(dir.replace(/[\\/]+$/, "") || dir); return; }
      } catch (e) { this.error = `Couldn't open the folder dialog: ${String(e?.message ?? e)}`; }
      this.choosing = false;
      cx.notify();
    });
  }

  // The remote browser: list `path`'s folders on that machine (path comes back resolved).
  goTo(path, cx) {
    if (!path) return;
    if (/^~([\\/]|$)/.test(path) && this.sys?.home) path = this.sys.home + path.slice(1);
    this.browse = { path, dirs: this.browse?.dirs ?? null, error: null, busy: true };
    this.browseInput.set_value(path);
    cx.notify();
    cx.spawn(async (cx) => {
      const sys = await this.system();
      let r;
      try {
        r = sys.posix
          ? await this.run("sh", ["-c", 'cd -- "$1" || exit 1; pwd; for d in */ .[!.]*/; do [ -d "$d" ] && printf "%s\n" "${d%/}"; done; exit 0', "sh", path])
          : await this.run("powershell.exe", ["-NoProfile", "-Command",
            `[Console]::OutputEncoding = [Text.Encoding]::UTF8; $p = Resolve-Path -LiteralPath '${path.replace(/'/g, "''")}' -ErrorAction Stop; $p.ProviderPath; Get-ChildItem -LiteralPath $p.ProviderPath -Directory -Force -ErrorAction SilentlyContinue | ForEach-Object { $_.Name }`]);
      } catch (e) { r = { code: 1, stderr: String(e?.message ?? e) }; }
      if (!this.browse) return;
      if (r.code !== 0) {
        this.browse = { ...this.browse, busy: false, error: (r.stderr || `No folder ${path} on ${this.machine}`).trim().slice(0, 200) };
      } else {
        const [here, ...dirs] = (r.stdout ?? "").split(/\r?\n/).map((x) => x.trim()).filter(Boolean);
        // Hidden folders after the rest, each part by name.
        dirs.sort((a, b) => (a.startsWith(".") - b.startsWith(".")) || a.localeCompare(b));
        this.browse = { path: here || path, dirs, error: null, busy: false };
        this.browseInput.set_value(this.browse.path);
      }
      cx.notify();
    });
  }

  // One level up from the browser's folder ("/" and "C:\" stay).
  parent(path) {
    const sep = this.sys?.sep ?? "/";
    const trimmed = path.replace(/[\\/]+$/, "");
    const i = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
    if (i < 0) return path;
    const up = trimmed.slice(0, i);
    return up === "" ? "/" : /^[A-Za-z]:$/.test(up) ? up + sep : up;
  }
  child(path, name) {
    const sep = this.sys?.sep ?? "/";
    return path.endsWith("/") || path.endsWith("\\") ? path + name : `${path}${sep}${name}`;
  }

  setBase(cx) {
    const base = this.baseInput.value().trim().replace(/[\\/]+$/, "");
    if (!base) return;
    saveFor(this.mk, { base });
    this.browse = null;
    this.found = {};
    cx.notify();
    cx.spawn(async (cx) => { await this.scan(); cx.notify(); });
  }

  // Clones under the repo folder, one or two levels down, by their origin.
  async scan() {
    const base = this.base();
    if (!base) return;
    const sys = await this.system();
    let r;
    try {
      r = sys.posix
        ? await this.run("sh", ["-c", 'cd "$1" 2>/dev/null || exit 0; for d in */ */*/; do [ -e "$d.git" ] && printf "%s\\t%s\\n" "$PWD/${d%/}" "$(git -C "$d" remote get-url origin 2>/dev/null)"; done; exit 0', "sh", base])
        : await this.run("powershell.exe", ["-NoProfile", "-Command",
          `$b='${base.replace(/'/g, "''")}'; if (Test-Path -LiteralPath $b) { Get-ChildItem -LiteralPath $b -Directory -Depth 1 -ErrorAction SilentlyContinue | Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName '.git') } | ForEach-Object { $u = git -C $_.FullName remote get-url origin 2>$null; "$($_.FullName)\`t$u" } }`]);
    } catch { return; }
    const found = {};
    for (const line of (r.stdout ?? "").split(/\r?\n/)) {
      const [path, url] = line.split("\t");
      const slug = slugOf(url);
      if (path && slug && !found[slug]) found[slug] = path.trim();
    }
    this.found = found;
  }

  // Drop remembered clones whose folder is gone.
  async prune() {
    const clones = this.clones();
    const paths = Object.entries(clones);
    if (!paths.length) return;
    const sys = await this.system();
    const keep = {};
    for (const [slug, path] of paths) {
      try {
        const r = sys.posix ? await this.run("sh", ["-c", '[ -e "$1/.git" ]', "sh", path])
          : await this.run("powershell.exe", ["-NoProfile", "-Command", `if (Test-Path -LiteralPath '${path.replace(/'/g, "''")}\\.git') { exit 0 } else { exit 1 }`]);
        if (r.code === 0) keep[slug] = path;
      } catch { keep[slug] = path; } // machine away: keep it
    }
    if (Object.keys(keep).length !== paths.length) saveFor(this.mk, { clones: keep });
  }

  list() {
    const q = this.query;
    return (this.repos ?? []).filter((r) => !q || r.slug.includes(q));
  }

  close() { const id = props()?.overlay; if (id) closeOverlay(id); }

  // A space there: the one already showing that folder, else a new one (named after its repo by Herdr).
  open(path) {
    const s = spaces().find((x) => (x.machine ?? null) === this.machine && sameDir(x.folder, path));
    if (s) run("space.select", { id: s.id });
    else run("space.new", { folder: path, machine: this.mk });
    this.close();
  }

  choose(repo, cx) {
    const path = this.where(repo);
    if (path) return this.open(path);
    this.picked = repo;
    if (!this.base()) this.choose_base(cx);
    cx.notify();
  }

  clone(cx) {
    const repo = this.picked;
    const base = this.base();
    if (!repo || !base || this.busy) return;
    this.busy = `Cloning ${repo.full}…`;
    cx.notify();
    cx.spawn(async (cx) => {
      try {
        const sys = await this.system();
        const dest = `${base}${sys.sep}${repo.name}`;
        const mk = sys.posix ? await this.run("mkdir", ["-p", base])
          : await this.run("powershell.exe", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${base.replace(/'/g, "''")}' | Out-Null`]);
        if (mk.code !== 0) throw new Error(mk.stderr || "couldn't make the folder");
        const r = await this.run("gh", ["repo", "clone", repo.full, dest], 600000);
        if (r.code !== 0) throw new Error((r.stderr || r.stdout || "clone failed").trim().slice(0, 300));
        saveFor(this.mk, { clones: { ...this.clones(), [repo.slug]: dest } });
        notify({ title: "Cloned", body: `${repo.full} → ${dest}`, level: "success" });
        this.open(dest);
      } catch (e) {
        this.busy = null;
        this.error = String(e?.message ?? e);
        cx.notify();
      }
    });
  }

  row(t, repo, i) {
    const path = this.where(repo);
    return h_flex().id(`repo-${i}`).h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().flex_none()
      .hover((s) => s.bg(t.hover))
      .when(this.picked?.slug === repo.slug, (el) => el.bg(t.selected ?? t.hover))
      .on_click((_e, cx) => this.choose(repo, cx))
      .child(div().flex_1().min_w(0).truncate().text_color(t.foreground).child(repo.full))
      .when(repo.private, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("private")))
      .child(path
        ? div().flex_none().px(5).rounded(4).text_size(10.5).bg(t.raised ?? t.hover).text_color(t.done ?? t.foreground).tooltip(path).child("cloned")
        : div().flex_none().text_size(10.5).text_color(t.dim).child(ago(repo.pushed)));
  }

  // The remote folder browser: path (type + Enter), up, its folders (click to go in), and what to do with it.
  browser(t, button) {
    const b = this.browse;
    const where = this.machine ?? "this computer";
    return v_flex().gap(5).p(6).flex_none().rounded(6).border_1().border_color(t.border)
      .child(div().text_size(11.5).text_color(t.muted).child(`Folders on ${where}`))
      .child(h_flex().gap(6).items_center()
        .child(div().id("repo-browse-up").size(28).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted)
          .bg(t.raised ?? t.hover).hover((s) => s.text_color(t.foreground)).cursor_pointer().tooltip("Up one folder")
          .on_click((_e, cx) => this.goTo(this.parent(b.path), cx)).child("↑"))
        .child(Input.new(this.browseInput).flex_1().h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12)))
      .when(Boolean(b.error), (el) => el.child(div().px(2).text_size(11.5).text_color(t.blocked).child(b.error)))
      .child(v_flex().id("repo-browse-list").h(150).overflow_y_scroll().gap(1)
        .when(b.busy && !b.dirs, (el) => el.child(div().px(8).py(4).text_color(t.dim).child("Loading…")))
        .when(!b.busy && b.dirs && !b.dirs.length && !b.error, (el) => el.child(div().px(8).py(4).text_color(t.dim).child("No folders here.")))
        .children((b.dirs ?? []).slice(0, 500).map((name, i) => h_flex().id(`repo-dir-${i}`).h(24).px(6).gap(7).items_center().rounded(5).flex_none()
          .cursor_pointer().hover((s) => s.bg(t.hover)).text_color(name.startsWith(".") ? t.dim : t.foreground)
          .on_click((_e, cx) => this.goTo(this.child(b.path, name), cx))
          .child(svg("mods/workspace-chrome/folder.svg").size(12).flex_none().text_color(t.dim))
          .child(div().flex_1().min_w(0).truncate().child(name)))))
      .child(h_flex().gap(6).items_center().justify_end()
        .child(button("repo-browse-space", "Open a space here", () => { if (!b.busy && !b.error) this.open(b.path); }, false))
        .child(button("repo-browse-use", "Use as repo folder", (_e, cx) => { if (b.busy || b.error) return; this.baseInput.set_value(b.path); this.setBase(cx); }, true)));
  }

  render() {
    const t = theme();
    const list = this.list();
    const where = this.machine ?? "this computer";
    const base = this.base();
    const button = (id, label, action, primary) => div().id(id).h(28).px(10).flex().items_center().rounded(6).flex_none().text_size(12)
      .when(primary, (el) => el.font_medium().bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? "#ffffff").hover((s) => s.opacity(0.88)))
      .when(!primary, (el) => el.text_color(t.muted).hover((s) => s.bg(t.hover)))
      .cursor_pointer().on_click(action).child(label);
    return v_flex().id("repo-menu").size_full().p(6).gap(6).bg(t.popover).text_size(12.5).text_color(t.foreground)
      .child(h_flex().gap(6).items_center().px(4)
        .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(`Open a repo on ${where}`))
        .when(this.repos === null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child("Loading…"))))
      // The repo folder, always shown: clones there are found, new ones go there. Choose changes it.
      .child(h_flex().gap(6).items_center().pl(8).pr(2).h(32).flex_none().rounded(6).border_1().border_color(t.border)
        .child(svg("mods/workspace-chrome/folder.svg").size(13).flex_none().text_color(t.dim))
        .child(div().flex_1().min_w(0).truncate().text_size(11.5).text_color(base ? t.foreground : t.dim).tooltip(base ?? "").child(base ?? "No repo folder yet"))
        .child(div().id("repo-base-choose").h(24).px(9).flex().items_center().rounded(5).flex_none().text_size(11.5)
          .text_color(t.muted).bg(t.raised ?? t.hover).hover((s) => s.text_color(t.foreground))
          .when(!this.choosing, (el) => el.cursor_pointer().on_click((_e, cx) => this.choose_base(cx)))
          .child(this.choosing ? "Choosing…" : this.browse ? "Close" : "Choose")))
      // A remote machine's folders, browsed here: this screen's dialog can't see its disks.
      .when(Boolean(this.browse), (el) => el.child(this.browser(t, button)))
      .child(Input.new(this.search).h(28).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12))
      .when(Boolean(this.error), (el) => el.child(div().px(6).text_size(11.5).text_color(t.blocked).child(this.error)))
      .child(v_flex().id("repo-list").flex_1().min_h(0).overflow_y_scroll().gap(1)
        .children(list.slice(0, 200).map((r, i) => this.row(t, r, i)))
        .when(this.repos !== null && !list.length && !this.error, (el) => el.child(div().px(8).py(6).text_color(t.dim).child("No repos match."))))
      .when(Boolean(this.picked) && Boolean(base) && !this.browse, (el) => el.child(h_flex().gap(6).items_center().p(6).rounded(6).border_1().border_color(t.border)
        .child(div().flex_1().min_w(0).text_size(11.5).text_color(this.busy ? (t.working ?? t.muted) : t.muted)
          .child(this.busy ?? `Clone ${this.picked.full} to ${base}${this.sys?.sep ?? "/"}${this.picked.name}`))
        .child(div().id("repo-clone").h(28).px(10).flex().items_center().rounded(6).flex_none().text_size(12).font_medium()
          .bg(t.solid ?? t.accent).text_color(t.solid_foreground ?? "#ffffff")
          .when(!this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click((_e, cx) => this.clone(cx)))
          .when(Boolean(this.busy), (el) => el.opacity(0.6))
          .child(this.busy ? "Cloning…" : "Clone"))))
      .child(div().h(1).flex_none().bg(t.border))
      // Any folder as a space, picked with the mouse.
      .child(h_flex().id("repo-open-folder").h(30).px(8).gap(8).items_center().rounded(6).flex_none().text_color(t.muted)
        .when(!this.choosing, (el) => el.cursor_pointer().hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => this.open_folder(cx)))
        .child(svg("mods/workspace-chrome/folder.svg").size(12))
        .child(div().flex_1().min_w(0).truncate().child(this.choosing ? "Choosing a folder…" : "Open a folder…"))
        .child(div().flex_none().text_size(10.5).text_color(t.dim).child(this.machine ? "browse its folders" : "pick it in a dialog")))
      .child(h_flex().id("repo-empty").h(30).px(8).gap(8).items_center().rounded(6).cursor_pointer().flex_none().text_color(t.muted)
        .hover((s) => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => { run("space.new", { machine: this.mk }); this.close(); })
        .child(svg("mods/workspace-chrome/plus.svg").size(12))
        .child("New empty space"));
  }
}

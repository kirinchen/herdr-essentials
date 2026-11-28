// k-settings Mods page (herdr-essentials, was k-mods): a mod manager laid out like VS Code's extensions view. Left: search,
// Installed / Marketplace tabs and a clickable list; right: the selected mod's details and its
// actions (install with a review of what the code does, update, uninstall, enable / disable).
//
// Derived from jacksonpires/herdr-app-mod-manager (MIT, (c) 2026 speardragon, (c) 2026 Jackson
// Pires; see LICENSE in this folder), itself a port of speardragon/herdr-plugin-manager.

import { View, div, svg } from "gpui-kit";
import { h_flex, v_flex, InputState, Input } from "gpui-base";
import { exec, appHome, readTextFile, writeTextFile, shared, setShared, props, closeOverlay, notify, theme, window, checking } from "herdr";
import * as core from "./core.js";

const RECORDS = "k-mods.installed";
const FETCH = 30;
const ICON = (name) => `mods/workspace-chrome/${name}.svg`;

const records = () => shared(RECORDS) ?? [];
const saveRecords = (list) => setShared(RECORDS, list);
const short = (sha) => (sha ? sha.slice(0, 7) : "?");
const sameRepo = (a, b) => (a ?? "").toLowerCase() === (b ?? "").toLowerCase();
const err = (e) => String(e?.message ?? e);

const anonymous = async (url) => {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "k-mods (herdr-app mod)" } });
  return { status: res.status, text: await res.text() };
};

export default class KMods extends View {
  init(_props, cx) {
    this.embedded = Boolean(_props?.embedded); // a page of k-settings, not its own dialog
    this.io = {
      get platform() { return window()?.platform ?? "linux"; },
      exec: (cmd, args, opts) => exec(cmd, args, opts),
      readText: (path) => readTextFile(path),
      async writeText(path, text) { await writeTextFile(path, text, await readTextFile(path)); },
    };
    this.fs = core.fsOps(this.io);
    this.tab = "installed";
    this.mods = [];
    this.loaded = false;
    this.updates = {};          // source -> newer sha, null when up to date; absent while checking
    this.usedBy = {};           // mod name -> layouts using it
    this.selInstalled = null;
    this.selMarket = null;
    this.showBuiltin = false;
    this.queries = { installed: "", market: "" };
    this.market = { items: [], total: 0, fetchedPages: 0, sort: "stars", error: null, loading: false, gen: 0 };
    this.review = null;
    this.confirm = null;
    this.busy = null;
    this.message = null;
    this.handle = cx.focus_handle();
    this.input = InputState.new({ placeholder: "Search mods" });
    this.input.on("change", (_e, cx) => this.onQuery(cx));
    this.input.on("submit", (_e, cx) => {
      if (this.tab === "market") cx.spawn(async (cx) => this.loadMarket(cx, true));
    });
    cx.timer.after(100, () => this.input.focus());
    cx.spawn(async (cx) => this.refresh(cx));
    if (checking()) return;
    // A panel closed while cloning can't clean up after itself; its clone goes the next time.
    this.fs.cleanStale(this.cacheDir()).catch(() => {});
  }

  cacheDir() { return core.join(this.io, appHome(), ".k-mods-cache"); }

  dismiss() {
    const id = props()?.overlay;
    if (id) closeOverlay(id);
  }

  // Closing the panel mid-review leaves no clone behind.
  async close() {
    if (this.review) await this.fs.rmrf(this.review.fetched.dir).catch(() => {});
  }

  // ------------------------------------------------------------------ data

  async refresh(cx, { remote = true } = {}) {
    try {
      this.mods = await core.listMods(this.io, { appHome: appHome(), records: records() });
      this.usedBy = {};
    } catch (e) {
      this.say(`Couldn't list the mods: ${err(e)}`, "error");
    }
    this.loaded = true;
    if (!this.selInstalled || !this.mods.some((m) => m.name === this.selInstalled)) {
      this.selInstalled = this.mods.find((m) => m.kind !== "herdr")?.name ?? this.mods[0]?.name ?? null;
    }
    this.loadUsage(cx);
    cx.notify();
    if (!remote || checking()) return;
    const sources = [...new Set(records().map((r) => r.source))];
    for (const source of sources) {
      core.remoteSha(this.io, source)
        .then((sha) => {
          const rec = records().find((r) => r.source === source);
          this.updates[source] = sha && rec && sha !== rec.sha ? sha : null;
          cx.notify();
        })
        .catch(() => { this.updates[source] = false; cx.notify(); });
    }
  }

  // Which layouts use the selected mod: shown in its details, and why Disable is refused.
  loadUsage(cx) {
    const name = this.selInstalled;
    if (!name || name in this.usedBy) return;
    this.usedBy[name] = null;
    cx.spawn(async (cx) => {
      try { this.usedBy[name] = await core.layoutsUsing(this.io, appHome(), name); }
      catch { this.usedBy[name] = []; }
      cx.notify();
    });
  }

  onQuery(cx) {
    const q = this.input.value();
    if (q === this.queries[this.tab]) return;
    this.queries[this.tab] = q;
    if (this.tab === "market") {
      // Search as the person types, once they pause (GitHub allows 30 searches a minute).
      const gen = ++this.market.gen;
      cx.timer.after(700, (cx) => { if (gen === this.market.gen) cx.spawn(async (cx) => this.loadMarket(cx, true)); });
    }
    cx.notify();
  }

  async loadMarket(cx, reset) {
    const m = this.market;
    const gen = reset ? ++m.gen : m.gen;
    if (reset) Object.assign(m, { items: [], total: 0, fetchedPages: 0 });
    m.loading = true;
    m.error = null;
    cx.notify();
    try {
      const r = await core.searchMarket(this.io, { query: this.queries.market, sort: m.sort, page: m.fetchedPages + 1, perPage: FETCH }, anonymous);
      if (gen !== m.gen) return;
      m.items.push(...r.items.filter((it) => !m.items.some((x) => x.fullName === it.fullName)));
      m.total = r.total;
      m.fetchedPages += 1;
      if (!this.selMarket || !m.items.some((x) => x.fullName === this.selMarket)) this.selMarket = m.items[0]?.fullName ?? null;
    } catch (e) {
      if (gen === m.gen) m.error = err(e);
    }
    if (gen === m.gen) m.loading = false;
    cx.notify();
  }

  say(text, level = "info") { this.message = text ? { text, level } : null; }

  async work(cx, label, fn) {
    this.busy = label;
    this.say(null);
    cx.notify();
    try {
      await fn(cx);
    } catch (e) {
      this.say(err(e), "error");
    }
    this.busy = null;
    cx.notify();
  }

  // ------------------------------------------------------------------ install / update review

  async startReview(cx, source, description) {
    await this.cancelReview();
    this.confirm = null;
    await this.work(cx, `Fetching ${source}…`, async () => {
      const fetched = await core.fetchSource(this.io, source, this.cacheDir());
      const packages = core.findPackages(fetched.files);
      if (!packages.length) {
        await this.fs.rmrf(fetched.dir).catch(() => {});
        throw new Error(`${source} has no mods/<name>/main.js folder`);
      }
      this.review = { source, description, fetched, packages, pkg: null, plan: null, record: null };
      if (packages.length === 1) await this.planFor(packages[0]);
    });
  }

  async planFor(pkg) {
    const r = this.review;
    const record = records().find((x) => x.source === r.source && x.prefix === pkg.prefix) ?? null;
    const off = this.mods.filter((m) => m.disabled && (record?.mods ?? []).includes(m.name));
    if (off.length) throw new Error(`Enable ${off.map((m) => m.name).join(", ")} before updating it.`);
    const plan = await core.planInstall(this.io, {
      appHome: appHome(), dir: r.fetched.dir, pkg, record,
      existingMods: this.mods.map((m) => m.name), existingLayouts: await core.listLayoutFiles(this.io, appHome()),
    });
    Object.assign(r, { pkg, record, plan });
  }

  async cancelReview() {
    const r = this.review;
    this.review = null;
    if (r) await this.fs.rmrf(r.fetched.dir).catch(() => {});
  }

  async install(cx) {
    const r = this.review;
    await this.work(cx, `${r.record ? "Updating" : "Installing"} ${r.pkg.name}…`, async () => {
      const rec = await core.applyInstall(this.io, {
        appHome: appHome(), plan: r.plan, source: r.source, prefix: r.pkg.prefix, sha: r.fetched.sha, record: r.record, description: r.description,
      });
      saveRecords([...records().filter((x) => !(x.source === rec.source && x.prefix === rec.prefix)), rec]);
      const failures = await core.checkMods(this.io, appHome(), rec.mods);
      const verb = r.record ? "updated" : "installed";
      const text = failures.length
        ? `${r.pkg.name} ${verb}, but herdr-app check failed for ${failures.map((f) => f.mod).join(", ")}: ${failures[0].error.split("\n")[0]}`
        : `${r.pkg.name} ${verb} (${rec.mods.join(", ")})${rec.layouts.length ? `; layouts: ${rec.layouts.join(", ")} (switch with ctrl-shift-l)` : ""}`;
      this.say(text, failures.length ? "error" : "success");
      notify({ title: `Mod ${verb}`, body: text, level: failures.length ? "warning" : "success" });
      this.updates[rec.source] = null;
      await this.cancelReview();
      this.tab = "installed";
      this.input.set_value(this.queries.installed);
      this.selInstalled = rec.mods[0];
      await this.refresh(cx, { remote: false });
    });
  }

  // Bulk update without a review, only for packages whose plan has no clash and adds no new
  // risk; anything else is left for its own Update button.
  async updateAll(cx, pending) {
    const done = [];
    const skipped = [];
    await this.work(cx, `Updating ${pending.length} package(s)…`, async () => {
      for (const rec of pending) {
        const fetched = await core.fetchSource(this.io, rec.source, this.cacheDir());
        try {
          const pkg = core.findPackages(fetched.files).find((p) => p.prefix === rec.prefix);
          if (!pkg) { skipped.push(`${rec.source}: the package is gone from the repo`); continue; }
          if (this.mods.some((m) => m.disabled && rec.mods.includes(m.name))) { skipped.push(`${pkg.name}: disabled`); continue; }
          const plan = await core.planInstall(this.io, {
            appHome: appHome(), dir: fetched.dir, pkg, record: rec,
            existingMods: this.mods.map((m) => m.name), existingLayouts: await core.listLayoutFiles(this.io, appHome()),
          });
          const before = new Set(rec.risks ?? []);
          const fresh = plan.risks.map((x) => x.label).filter((l) => !before.has(l));
          if (plan.clashes.length || fresh.length) { skipped.push(`${pkg.name}: ${plan.clashes.length ? "name clash" : `now ${fresh.join(", ")}`}`); continue; }
          const next = await core.applyInstall(this.io, { appHome: appHome(), plan, source: rec.source, prefix: rec.prefix, sha: fetched.sha, record: rec });
          saveRecords([...records().filter((x) => !(x.source === rec.source && x.prefix === rec.prefix)), next]);
          this.updates[rec.source] = null;
          done.push(pkg.name);
        } finally {
          await this.fs.rmrf(fetched.dir).catch(() => {});
        }
      }
      await this.refresh(cx, { remote: false });
      this.say([done.length ? `Updated: ${done.join(", ")}` : "", skipped.length ? `Skipped (update them one by one): ${skipped.join("; ")}` : ""]
        .filter(Boolean).join(" · "), skipped.length ? "error" : "success");
    });
  }

  // ------------------------------------------------------------------ uninstall / enable / disable

  askUninstall(mod) {
    if (mod.kind === "herdr") return this.say("Herdr's own mods can't be removed; they come back with every app start.", "error");
    if (mod.name === core.SELF) return this.say("The mod manager (k-settings) can't uninstall itself.", "error");
    const what = mod.record
      ? `Delete ${mod.record.mods.map((m) => `mods/${m}`).join(", ")}${mod.record.layouts?.length ? `, layouts ${mod.record.layouts.join(", ")}` : ""} and the keys it added.`
      : mod.symlink ? `Remove the link mods/${mod.name}; the folder it points to stays.`
      : `Delete the folder ${mod.disabled ? core.DISABLED_DIR : "mods"}/${mod.name}. It wasn't installed from a repo, so it can't be reinstalled from here.`;
    this.confirm = { title: `Uninstall ${mod.record ? mod.record.mods.join(" + ") : mod.name}?`, text: what, label: mod.symlink && !mod.record ? "Remove link" : "Uninstall", danger: true, run: (cx) => this.remove(cx, mod) };
  }

  async remove(cx, mod) {
    await this.work(cx, `Removing ${mod.name}…`, async () => {
      if (mod.record) {
        await core.uninstall(this.io, { appHome: appHome(), record: mod.record });
        saveRecords(records().filter((x) => !(x.source === mod.record.source && x.prefix === mod.record.prefix)));
        this.say(`Uninstalled ${mod.record.mods.join(", ")}`, "success");
      } else {
        await core.removeLocal(this.io, { appHome: appHome(), name: mod.name, disabled: mod.disabled });
        this.say(mod.symlink ? `Link ${mod.name} removed (its folder stays)` : `Deleted ${mod.name}`, "success");
      }
      this.selInstalled = null;
      await this.refresh(cx, { remote: false });
    });
  }

  async toggle(cx, mod) {
    if (!mod.disabled) {
      const blocker = await core.disableBlocker(this.io, { appHome: appHome(), mod }).catch((e) => err(e));
      if (blocker) { this.say(`Can't disable ${mod.name}: ${blocker}`, "error"); cx.notify(); return; }
    }
    await this.work(cx, `${mod.disabled ? "Enabling" : "Disabling"} ${mod.name}…`, async () => {
      if (mod.disabled) await core.enable(this.io, { appHome: appHome(), name: mod.name });
      else await core.disable(this.io, { appHome: appHome(), name: mod.name });
      this.say(mod.disabled ? `Enabled ${mod.name}` : `Disabled ${mod.name} (moved to ${core.DISABLED_DIR}/${mod.name})`, "success");
      await this.refresh(cx, { remote: false });
    });
  }

  openUrl(url) {
    this.fs.openUrl(url).catch((e) => notify({ title: "Couldn't open the link", body: err(e), level: "error" }));
  }

  // ------------------------------------------------------------------ selection and keys

  switchTab(tab, cx) {
    if (this.tab === tab) return;
    this.tab = tab;
    this.confirm = null;
    this.input.set_value(this.queries[tab]);
    if (tab === "market" && !this.market.fetchedPages && !this.market.loading) cx.spawn(async (cx) => this.loadMarket(cx, true));
    cx.notify();
  }

  select(tab, key, cx) {
    if (tab === "installed") this.selInstalled = key; else this.selMarket = key;
    this.confirm = null;
    if (this.review) cx.spawn(async () => this.cancelReview());
    this.say(null);
    this.loadUsage(cx);
    cx.notify();
  }

  visibleInstalled() {
    const q = this.queries.installed.trim().toLowerCase();
    const match = (m) => !q || m.name.toLowerCase().includes(q) || (m.record?.source ?? "").toLowerCase().includes(q) || m.title.toLowerCase().includes(q);
    const mine = this.mods.filter((m) => m.kind !== "herdr" && match(m));
    const builtin = this.mods.filter((m) => m.kind === "herdr" && match(m));
    return { mine, builtin, builtinOpen: this.showBuiltin || (q !== "" && builtin.length > 0) };
  }

  move(delta, cx) {
    if (this.tab === "installed") {
      const v = this.visibleInstalled();
      const names = [...v.mine, ...(v.builtinOpen ? v.builtin : [])].map((m) => m.name);
      const i = names.indexOf(this.selInstalled);
      const next = names[Math.max(0, Math.min(names.length - 1, i + delta))];
      if (next) this.select("installed", next, cx);
    } else {
      const names = this.market.items.map((it) => it.fullName);
      const i = names.indexOf(this.selMarket);
      const next = names[Math.max(0, Math.min(names.length - 1, i + delta))];
      if (next) this.select("market", next, cx);
    }
  }

  onKey(e, cx) {
    if (e.key === "escape") {
      if (this.confirm) this.confirm = null;
      else if (this.review) cx.spawn(async () => this.cancelReview());
      else this.dismiss();
    } else if (e.key === "down") this.move(1, cx);
    else if (e.key === "up") this.move(-1, cx);
    else return;
    cx.stop_propagation();
    cx.notify();
  }

  // ------------------------------------------------------------------ view helpers

  button(id, text, { primary = false, danger = false, off = false } = {}, action) {
    const t = theme();
    const fill = danger ? t.blocked : primary ? t.solid : t.raised;
    return h_flex().id(id).h(28).px(12).items_center().rounded(7).flex_none()
      .border_1().border_color(primary || danger ? fill : t.input).bg(fill)
      .text_color(primary ? t.solid_foreground : danger ? t.background : t.foreground).text_size(12.5).font_medium()
      .when(off || Boolean(this.busy), (el) => el.opacity(0.45))
      .when(!off && !this.busy, (el) => el.cursor_pointer().hover((s) => s.opacity(0.85)).on_click(action))
      .child(text);
  }

  badge(text, color) {
    return div().flex_none().px(5).h(16).flex().items_center().rounded(4).border_1().border_color(color).text_color(color).text_size(10.5).child(text);
  }

  sourceLine(m) {
    if (m.record) return `${m.record.source}${m.record.prefix ? `/${m.record.prefix}` : ""} @${short(m.record.sha)}`;
    if (m.kind === "herdr") return "Herdr";
    return m.symlink ? "link" : "local";
  }

  installedRow(m, t) {
    const sel = this.selInstalled === m.name && this.tab === "installed";
    const update = m.record && this.updates[m.record.source];
    return v_flex().id(`mod-${m.name}`).h(44).px(10).justify_center().rounded(7).flex_none().cursor_pointer()
      .when(sel, (el) => el.bg(t.selected)).when(!sel, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.select("installed", m.name, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(m.disabled ? t.dim : m.kind === "herdr" ? t.muted : t.foreground).child(m.name))
        .when(Boolean(update), (el) => el.child(this.badge("update available", t.blocked)))
        .when(m.disabled, (el) => el.child(this.badge("Disabled", t.dim))))
      .child(div().text_size(11.5).truncate().text_color(t.dim).child(this.sourceLine(m)));
  }

  marketRow(it, t, installed) {
    const sel = this.selMarket === it.fullName && this.tab === "market";
    return v_flex().id(`market-${it.fullName}`).h(48).px(10).justify_center().rounded(7).flex_none().cursor_pointer()
      .when(sel, (el) => el.bg(t.selected)).when(!sel, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.select("market", it.fullName, cx))
      .child(h_flex().gap(6).items_center()
        .child(div().flex_1().min_w(0).truncate().font_medium().text_color(t.foreground).child(it.fullName))
        .when(installed, (el) => el.child(this.badge("Installed", t.done)))
        .child(div().flex_none().text_size(11.5).text_color(t.muted).child(`★ ${it.stars}`)))
      .child(div().text_size(11.5).truncate().text_color(t.dim).child(it.description || "No description"));
  }

  tabButton(id, label, t) {
    const on = this.tab === id;
    return h_flex().id(`tab-${id}`).h(28).px(10).items_center().rounded(6).cursor_pointer().text_size(12.5)
      .font_medium().text_color(on ? t.foreground : t.muted)
      .when(on, (el) => el.bg(t.selected)).when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click((_e, cx) => this.switchTab(id, cx))
      .child(label);
  }

  leftColumn(t) {
    const header = h_flex().gap(4).items_center()
      .child(this.tabButton("installed", `Installed ${this.mods.filter((m) => m.kind !== "herdr").length}`, t))
      .child(this.tabButton("market", "Marketplace", t))
      .child(div().flex_1())
      .when(this.tab === "market", (el) => el.child(
        h_flex().id("sort").h(24).px(8).items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Sort order")
          .on_click((_e, cx) => { this.market.sort = this.market.sort === "stars" ? "updated" : "stars"; cx.spawn(async (cx) => this.loadMarket(cx, true)); })
          .child(this.market.sort === "stars" ? "★ Most stars" : "Recently updated")));
    let rows;
    if (this.tab === "installed") {
      const v = this.visibleInstalled();
      const pending = records().filter((r) => this.updates[r.source]);
      rows = [
        ...(pending.length ? [h_flex().px(10).pb(4).child(this.button("update-all", `Update all (${pending.length})`, {}, () => {
          this.confirm = { title: `Update ${pending.length} package(s)?`, text: `${pending.map((r) => r.mods.join(" + ")).join(", ")}. A package whose new version clashes or adds a new risk is skipped; update it on its own to see the review.`, label: "Update all", run: (cx) => this.updateAll(cx, pending) };
        }))] : []),
        ...v.mine.map((m) => this.installedRow(m, t)),
        ...(!this.loaded ? [div().px(10).text_color(t.dim).child("Loading…")]
          : !v.mine.length ? [div().px(10).py(6).text_size(12).text_color(t.dim).child(this.queries.installed ? "No mod of yours matches." : "No mods of yours yet: see Marketplace.")] : []),
        v.builtin.length
          ? h_flex().id("builtin-toggle").h(28).mt(6).px(8).gap(6).items_center().rounded(6).cursor_pointer().text_size(11.5).font_semibold().text_color(t.muted)
            .hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.showBuiltin = !this.showBuiltin; cx.notify(); })
            .child(svg(ICON(v.builtinOpen ? "chevron-down" : "chevron-right")).size(12))
            .child(`BUILT-IN (${v.builtin.length})`)
          : null,
        ...(v.builtinOpen ? v.builtin.map((m) => this.installedRow(m, t)) : []),
      ].filter(Boolean);
    } else {
      const m = this.market;
      const installed = new Set(records().map((r) => r.source.toLowerCase()));
      rows = m.items.map((it) => this.marketRow(it, t, installed.has(it.fullName.toLowerCase())));
      if (m.error) rows.push(div().px(10).py(6).text_size(12).text_color(t.blocked).child(m.error));
      if (m.loading) rows.push(div().px(10).py(6).text_size(12).text_color(t.dim).child("Loading…"));
      else if (!m.error && !m.items.length) rows.push(div().px(10).py(6).text_size(12).text_color(t.dim).child("No mods found."));
      if (!m.loading && m.items.length < m.total) {
        rows.push(h_flex().px(10).py(6).gap(8).items_center()
          .child(this.button("load-more", "Load more", {}, (_e, cx) => cx.spawn(async (cx) => this.loadMarket(cx, false))))
          .child(div().text_size(11.5).text_color(t.dim).child(`${m.items.length} of ${m.total}`)));
      } else if (m.items.length) {
        rows.push(div().px(10).py(6).text_size(11.5).text_color(t.dim).child(`${m.items.length} of ${m.total} · GitHub topic ${core.MARKET_TOPIC}`));
      }
    }
    return v_flex().w(340).flex_none().min_h(0).gap(8)
      .child(h_flex().h(32).px(10).gap(8).items_center().rounded(8).border_1().border_color(t.input).bg(t.background)
        .child(svg(ICON("search")).size(13).text_color(t.dim))
        .child(Input.new(this.input).flex_1().h_full().text_size(12.5).text_color(t.foreground)))
      .child(header)
      .child(v_flex().id(`list-${this.tab}`).flex_1().min_h(0).gap(1).overflow_y_scrollbar().children(rows));
  }

  field(t, label, value, color) {
    if (value == null || value === "" || (Array.isArray(value) && !value.length)) return null;
    return h_flex().gap(10).items_start()
      .child(div().w(110).flex_none().text_size(12).text_color(t.dim).child(label))
      .child(div().flex_1().min_w(0).text_size(12.5).text_color(color ?? t.foreground).child(Array.isArray(value) ? value.join(", ") : String(value)));
  }

  section(t, title, lines) {
    return v_flex().gap(3).child(div().text_size(12).font_semibold().text_color(t.foreground).child(title)).children(lines.filter(Boolean));
  }

  line(t, text, color) { return div().text_size(12.5).text_color(color ?? t.muted).child(text); }

  confirmBox(t) {
    const c = this.confirm;
    return v_flex().gap(8).p(12).rounded(8).border_1().border_color(c.danger ? t.blocked : t.accent).bg(t.surface)
      .child(div().font_semibold().text_color(t.foreground).child(c.title))
      .child(div().text_size(12.5).text_color(t.muted).child(c.text))
      .child(h_flex().gap(8)
        .child(this.button("confirm-yes", c.label, { primary: !c.danger, danger: c.danger }, (_e, cx) => { this.confirm = null; cx.spawn(async (cx) => c.run(cx)); }))
        .child(this.button("confirm-no", "Cancel", {}, (_e, cx) => { this.confirm = null; cx.notify(); })));
  }

  title(t, name, badges, sub) {
    return v_flex().gap(2)
      .child(h_flex().gap(8).items_center().child(div().text_size(17).font_semibold().text_color(t.foreground).truncate().child(name)).children(badges.filter(Boolean)))
      .when(Boolean(sub), (el) => el.child(div().text_size(12).text_color(t.dim).child(sub)));
  }

  installedDetails(t) {
    const m = this.mods.find((x) => x.name === this.selInstalled);
    if (!m) return [div().text_color(t.dim).child(this.loaded ? "Pick a mod on the left." : "Loading…")];
    const r = m.record;
    const update = r ? this.updates[r.source] : undefined;
    const used = this.usedBy[m.name];
    const page = r && core.repoPage(r.source);
    const builtin = m.kind === "herdr";
    const buttons = [];
    if (r) buttons.push(this.button("update", update ? `Update to ${short(update)}` : "Update", { primary: Boolean(update), off: m.disabled },
      (_e, cx) => cx.spawn(async (cx) => this.startReview(cx, r.source, r.description))));
    if (!builtin) {
      buttons.push(this.button("toggle", m.disabled ? "Enable" : "Disable", { primary: m.disabled, off: m.name === core.SELF }, (_e, cx) => cx.spawn(async (cx) => this.toggle(cx, m))));
      buttons.push(this.button("uninstall", m.symlink && !r ? "Remove link" : "Uninstall", { off: m.name === core.SELF }, (_e, cx) => { this.askUninstall(m); cx.notify(); }));
    }
    if (page) buttons.push(this.button("open-repo", "Open repo", {}, () => this.openUrl(page)));
    const where = core.join(this.io, appHome(), m.disabled ? core.DISABLED_DIR : "mods", m.name);
    const kind = r ? "Installed from a repo" : builtin ? "Built into Herdr: read-only (mod.clone makes your own copy)" : m.symlink ? "Your mod (a link to a folder elsewhere)" : "Your mod (no source recorded, so no updates)";
    return [
      this.title(t, m.name, [m.disabled ? this.badge("Disabled", t.dim) : null, update ? this.badge("update available", t.blocked) : null,
        builtin ? this.badge("Built-in", t.dim) : null, m.symlink ? this.badge("link", t.muted) : null], m.title && m.title !== m.name ? m.title : null),
      buttons.length ? h_flex().gap(8).flex_wrap().children(buttons) : null,
      this.confirm ? this.confirmBox(t) : null,
      v_flex().flex_1().min_h(0).gap(6).id("details").overflow_y_scrollbar().children([
        this.field(t, "Kind", kind),
        this.field(t, "Description", r?.description || m.description || null),
        this.field(t, "Source", r ? `${r.source}${r.prefix ? ` (folder ${r.prefix})` : ""}` : m.symlink ? "link" : builtin ? null : "local"),
        r ? this.field(t, "Commit", `${short(r.sha)} · installed ${r.at?.slice(0, 10) ?? "?"}`) : null,
        r ? this.field(t, "Update", update ? `${short(update)} available` : update === null ? "Up to date" : update === false ? "Couldn't check (offline?)" : "Checking…", update ? t.blocked : t.muted) : null,
        r ? this.field(t, "Mods", r.mods) : null,
        r ? this.field(t, "Layouts", r.layouts ?? []) : null,
        r ? this.field(t, "Keys", (r.keys ?? []).map((k) => `${k.key} → ${k.action}`)) : null,
        r ? this.field(t, "Risks", r.risks?.length ? r.risks : "none found", r.risks?.length ? t.blocked : t.done) : null,
        this.field(t, "Used by layouts", used == null ? null : used.length ? used : "none"),
        this.field(t, "Folder", where, t.muted),
      ].filter(Boolean)),
    ].filter(Boolean);
  }

  marketDetails(t) {
    const it = this.market.items.find((x) => x.fullName === this.selMarket);
    if (!it) return [div().text_color(t.dim).child(this.market.loading ? "Loading…" : "Pick a mod on the left.")];
    const rec = records().find((r) => sameRepo(r.source, it.fullName));
    const update = rec && this.updates[rec.source];
    const buttons = [
      rec
        ? this.button("install", update ? `Update to ${short(update)}` : "Reinstall / update", { primary: Boolean(update) }, (_e, cx) => cx.spawn(async (cx) => this.startReview(cx, rec.source, it.description)))
        : this.button("install", "Install", { primary: true }, (_e, cx) => cx.spawn(async (cx) => this.startReview(cx, it.fullName, it.description))),
      this.button("open-repo", "Open repo", {}, () => this.openUrl(it.url)),
    ];
    return [
      this.title(t, it.fullName, [rec ? this.badge("Installed", t.done) : null], `★ ${it.stars} · updated ${it.pushedAt?.slice(0, 10) ?? "?"}`),
      h_flex().gap(8).children(buttons),
      v_flex().gap(6).children([
        this.field(t, "Description", it.description || "No description"),
        this.field(t, "Repository", it.url, t.muted),
        rec ? this.field(t, "Installed", `${rec.mods.join(", ")} @${short(rec.sha)}`) : null,
      ].filter(Boolean)),
      div().text_size(12).text_color(t.dim).child("Install shows a review first: what gets copied, whether the code runs programs, reaches the network or touches files, and which keys it adds."),
    ].filter(Boolean);
  }

  reviewDetails(t) {
    const r = this.review;
    if (!r.plan) {
      return [
        this.title(t, r.source, [], `${r.packages.length} packages in this repo · commit ${short(r.fetched.sha)} · pick one`),
        v_flex().gap(2).children(r.packages.map((p) => h_flex().id(`pkg-${p.prefix || "root"}`).h(40).px(10).gap(10).items_center().rounded(7).cursor_pointer()
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => cx.spawn(async (cx) => this.work(cx, "Checking…", () => this.planFor(p))))
          .child(div().w(160).flex_none().truncate().font_medium().text_color(t.foreground).child(p.prefix || "(root)"))
          .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim)
            .child(`mods: ${p.mods.join(", ")}${p.layouts.length ? ` · layouts: ${p.layouts.length}` : ""}${p.recipe ? "" : " · no RECIPE.md"}`)))),
        h_flex().gap(8).child(this.button("review-cancel", "Cancel", {}, (_e, cx) => cx.spawn(async (cx) => { await this.cancelReview(); cx.notify(); }))),
      ];
    }
    const { plan, pkg, fetched, record } = r;
    const blocked = plan.clashes.length > 0;
    const sections = [
      this.section(t, "What gets added", [
        this.line(t, `mods: ${plan.mods.map((m) => `mods/${m}`).join(", ")}`),
        plan.layouts.length ? this.line(t, `layouts: ${plan.layouts.join(", ")} (your current layout isn't switched)`) : null,
        this.line(t, `${pkg.files.length} file(s) · commit ${short(fetched.sha)}${record ? ` (installed: ${short(record.sha)})` : ""}${pkg.recipe ? "" : " · no RECIPE.md"}`),
      ]),
      this.section(t, "What the code does", plan.risks.length
        ? plan.risks.map((x) => this.line(t, `• ${x.label}: ${x.paths.map((p) => p.split("/").slice(-2).join("/")).join(", ")}`, t.blocked))
        : [this.line(t, "Doesn't run programs, reach the network, or read or write files.", t.done)]),
      this.section(t, "Keys", [
        ...plan.keyAdds.map((k) => this.line(t, `+ ${k.key} → ${k.action} (${k.section})`)),
        ...plan.keyConflicts.map((k) => this.line(t, `= ${k.key} stays ${k.current}; the mod wanted ${k.action}`, t.blocked)),
        ...(plan.keyAdds.length || plan.keyConflicts.length ? [] : [this.line(t, "none")]),
      ]),
      blocked ? this.section(t, "Blocked", [this.line(t, `${plan.clashes.join(", ")} already exists and wasn't installed from here; nothing is overwritten. Remove or rename yours first.`, t.blocked)]) : null,
    ];
    return [
      this.title(t, `${record ? "Update" : "Install"} ${pkg.name}`, [this.badge("Review", t.accent)], r.source),
      h_flex().gap(8)
        .child(this.button("review-confirm", record ? "Confirm update" : "Confirm install", { primary: true, off: blocked }, (_e, cx) => cx.spawn(async (cx) => this.install(cx))))
        .child(this.button("review-cancel", "Cancel", {}, (_e, cx) => cx.spawn(async (cx) => { await this.cancelReview(); this.say("Cancelled"); cx.notify(); })))
        .when(Boolean(core.repoPage(r.source)), (el) => el.child(this.button("review-open", "Open repo", {}, () => this.openUrl(core.repoPage(r.source))))),
      div().text_size(12).text_color(t.dim).child("Herdr doesn't review mods. Look at the repository before installing one that runs programs or reaches the network."),
      v_flex().id("review").flex_1().min_h(0).gap(12).overflow_y_scrollbar().children(sections.filter(Boolean)),
    ];
  }

  render(_cx) {
    const t = theme();
    const right = this.review ? this.reviewDetails(t) : this.tab === "installed" ? this.installedDetails(t) : this.marketDetails(t);
    const msg = this.busy
      ? div().text_size(12).text_color(t.working).child(this.busy)
      : this.message
        ? div().text_size(12).text_color(this.message.level === "error" ? t.blocked : this.message.level === "success" ? t.done : t.foreground).child(this.message.text)
        : null;
    return v_flex().id("root").track_focus(this.handle).size_full().p(16).gap(12).when(!this.embedded, (el) => el.bg(t.popover)).text_size(13).text_color(t.foreground)
      .on_key_down((e, cx) => this.onKey(e, cx))
      .child(h_flex().gap(10).items_center()
        .child(div().text_size(15).font_semibold().child("Mods"))
        .child(div().text_size(12).text_color(t.dim).child(`${this.mods.filter((m) => m.kind !== "herdr").length} yours · ${this.mods.filter((m) => m.kind === "herdr").length} built-in`))
        .child(div().flex_1())
        .child(h_flex().id("reload").h(24).px(8).items_center().rounded(6).cursor_pointer().text_size(11.5).text_color(t.dim)
          .hover((s) => s.bg(t.hover).text_color(t.foreground)).tooltip("Reload the list and check for updates")
          .on_click((_e, cx) => { if (this.tab === "market") cx.spawn(async (cx) => this.loadMarket(cx, true)); cx.spawn(async (cx) => this.refresh(cx)); })
          .child("Reload"))
        .when(!this.embedded, (el) => el.child(div().text_size(11).text_color(t.dim).child("Esc"))))
      .child(h_flex().flex_1().min_h(0).gap(14).items_start()
        .child(this.leftColumn(t).h_full())
        .child(v_flex().flex_1().min_w(0).h_full().p(16).gap(12).rounded(10).border_1().border_color(t.border).bg(t.surface).children(right.filter(Boolean))))
      .when(Boolean(msg), (el) => el.child(msg));
  }
}

// k-spaces (herdr-essentials): the shipped spaces sidebar, plus a fold-out list of each
// space's tabs, settled ones included: click one to bring it back, its trash really closes it.
//
// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Agent state lives in the agents list, not here. Click to
// switch, right-click for its menu, drag to reorder. A machine's "+" lists its GitHub repos (repos.js).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle } from "gpui-base";
import { spaces, machines, panes, agents, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout, props } from "herdr";
import RepoMenu from "./repos.js";
import AgentMenu from "./agents.js";
import KMenu, { hidden } from "./menu.js";
import { AgentsInfo, ProjectInfo } from "./inspect.js";

// k-spaces: a machine's "+" opens a menu of its GitHub repos (repos.js); this mod again, as a popup.
// k-spaces: a space row's "+" opens a new-tab menu for that space: terminal or agent, YOLO or not (agents.js).
const agentMenu = (w) => openOverlay({ mod: "k-spaces", kind: "popup", width: 270, height: 400, props: { agentMenu: true, space: w.id, machine: w.machine ?? null } });
const repoMenu = (m) => openOverlay({ mod: "k-spaces", kind: "popup", width: 400, height: 520, props: { repoMenu: true, machine: m ?? null } });

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// The sidebar's rail goes by its width, not a flag: dragging its edge narrows it too.
const narrow = () => (find(layout(), "sidebar")?.size?.px ?? Infinity) < 160;

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const rowHeight = ({ tree }) => (tree ? 28 : 30);
const RAIL_CELL = 32;
// A space's name and its git tail never shrink below this, so a short one ("api")
// stays readable instead of turning into an ellipsis next to a long branch.
const SIDE_MIN = 48;
const railCell = (el) => h_flex().flex_none().justify_center().child(el);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
// Places looked at together (two git runs each). All at once, a few hundred spaces
// run out of the app's open files (256 when started from the Dock on macOS) or
// past a machine core's 16 running execs, and those spaces wait for FALLBACK.
const AT_ONCE = 6;

// Both runs, finished: a place isn't done while one of its runs still holds a slot.
async function both(a, b) {
  const done = await Promise.allSettled([a, b]);
  const failed = done.find((d) => d.status === "rejected");
  if (failed) throw failed.reason;
  return done.map((d) => d.value);
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

// A space speaks up only when something in it needs you.
export function glyph(status) {
  return status === "blocked" || status === "done" ? "●" : "·";
}

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    if (props()?.kMenu) { this.repoView = cx.new(KMenu, {}); return; }
    if (props()?.agentsInfo === true) { const m = props().machine; this.repoView = cx.new(AgentsInfo, { machine: typeof m === "string" && m ? m : null }); return; }
    if (props()?.projectInfo === true) { const p = props(); this.repoView = cx.new(ProjectInfo, { machine: typeof p.machine === "string" && p.machine ? p.machine : null, path: p.path, name: p.name }); return; }
    if (props()?.agentMenu === true) { const m = props().machine; this.repoView = cx.new(AgentMenu, { space: props().space, machine: typeof m === "string" && m ? m : null }); return; }
    if (props()?.repoMenu === true) { const m = props().machine; this.repoView = cx.new(RepoMenu, { machine: typeof m === "string" && m ? m : null }); return; }
    try { this.tabsOpen = new Set(JSON.parse(localStorage.getItem("k.tabs.open") ?? "[]")); } catch { this.tabsOpen = new Set(); }
    // k-spaces: Del ends the tab last pressed in the fold-out list, while the list has the keyboard.
    this.handle = cx.focus_handle();
    this.cursor = null;
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Map(); // local repos' pending folder watches
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.scroll = ScrollHandle.new(); // the list's position: the active space is brought into view through it
    this.activeAt = -1; // the active space's place among the list's children (headers and rows), -1 when not drawn
    this.machines = [];
    try {
      this.reconnecting = JSON.parse(localStorage.getItem("machines.reconnecting") ?? "{}");
      if (!this.reconnecting || typeof this.reconnecting !== "object" || Array.isArray(this.reconnecting)) this.reconnecting = {};
      for (const state of Object.values(this.reconnecting)) state.busy = false;
    } catch { this.reconnecting = {}; }
    try { this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]")); } catch { this.folded = new Set(); }
    this.refreshMachines(cx);
    cx.timer.every(15000, cx => this.refreshMachines(cx));
    // Refresh only when the refs could have changed (see `due`).
    cx.timer.every(250, (cx) => this.checkNew(cx));
  }

  checkNew(cx) {
    const now = Date.now();
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id)) || this.orderingDue(now)) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    for (const k of Object.keys(this.git)) if (!keys.has(k)) {
      delete this.git[k];
      delete this.checked[k];
      this.unsure.delete(k);
    }
    const repos = new Set(Object.values(this.git).filter(Boolean).map((g) => g.repo));
    for (const [repo, pending] of this.watching) if (!repos.has(JSON.stringify([null, repo]))) {
      this.watching.delete(repo);
      pending.cancel();
    }
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  rebuilt(machine) {
    return machine?.state === "unreachable" && /^a different core answers there \("[^"]+"\)$/.test(machine.why ?? "");
  }

  reconnect(machine, cx) {
    const name = machine.name;
    if (this.reconnecting[name]?.busy) return;
    const state = this.reconnecting[name] ??= { machine, removed: false };
    state.busy = true;
    state.error = null;
    localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
    cx.notify();
    cx.spawn(async cx => {
      try {
        const ask = async args => {
          const r = await hc([...args, "--json"]);
          if (r.code !== 0) {
            let error;
            try { error = JSON.parse(r.stdout || r.stderr).error?.message; } catch {}
            throw new Error(error || r.stderr || r.stdout || "Couldn't connect.");
          }
        };
        if (!state.removed) {
          await ask(["machine", "rm", name]);
          state.removed = true;
          localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
        }
        const args = ["machine", "add"];
        if (machine.via) args.push("--via", machine.target);
        else args.push(machine.target);
        args.push("--name", name);
        if (machine.session) args.push("--session", machine.session);
        if (machine.temporary) args.push("--temp");
        await ask(args);
        this.folded.delete(name);
        localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
        delete this.reconnecting[name];
      } catch (e) {
        state.error = String(e.message ?? e);
        state.busy = false;
      }
      localStorage.setItem("machines.reconnecting", JSON.stringify(this.reconnecting));
      this.refreshMachines(cx);
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        let next = 0;
        await Promise.all(Array.from({ length: Math.min(AT_ONCE, keys.length) }, async () => {
          while (next < keys.length) await this.check(keys[next++], cx);
        }));
      }
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // Ref-only reads avoid scanning the worktree or waking its index watch.
      // Two reads: a folder name may itself contain a newline.
      const [r, common] = await both(
        exec("git", ["rev-parse", "--path-format=absolute", "--show-toplevel"], { cwd, on }),
        exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on }),
      );
      if (r.code !== 0 || common.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.code !== 0 ? r.stderr : common.stderr)) {
          this.unsure.add(key);
          this.git[key] ??= null;
        } else this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = r.stdout.replace(/\n$/, ""), repo = common.stdout.replace(/\n$/, "");
      const [branch, counts] = await both(
        exec("git", ["symbolic-ref", "-q", "HEAD"], { cwd, on }),
        exec("git", ["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], { cwd, on }),
      );
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const [ahead, behind] = counts.code === 0 ? counts.stdout.trim().split(/\s+/).map(Number) : [0, 0];
      const info = { name, branch: branch.code === 0 ? branch.stdout.trim().replace(/^refs\/heads\//, "") : "(detached)", ahead, behind, repo: JSON.stringify([on, repo]), linked: repo !== `${top}/.git` };
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    const pending = watchFolder(repo);
    this.watching.set(repo, pending);
    cx.spawn(async (cx) => {
      let current = pending;
      try {
        for (;;) {
          await current;
          if (this.watching.get(repo) !== current) return;
          const mine = JSON.stringify([null, repo]);
          const keys = Object.keys(this.git).filter((k) => this.git[k]?.repo === mine);
          if (!keys.length) break;
          this.refreshGit(keys, cx);
          current = watchFolder(repo);
          this.watching.set(repo, current);
        }
      } catch {}
      if (this.watching.get(repo) === current) this.watching.delete(repo);
    });
  }

  // k-spaces: "Select Opened" (IntelliJ's Select Opened File): the shown session's space is unfolded
  // (its machine too, and shown if it was hidden), its tabs folded out, and the list scrolled to it.
  locate(cx) {
    const w = spaces().find(s => s.active);
    if (!w) return;
    if (this.folded.delete(w.machine ?? null)) localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
    if (!this.tabsOpen.has(w.id)) { this.tabsOpen.add(w.id); localStorage.setItem("k.tabs.open", JSON.stringify([...this.tabsOpen])); }
    if (this.isHidden(w) && shared("k-spaces.showHidden") !== true) setShared("k-spaces.showHidden", true);
    this.revealed = null; // the next render scrolls to it again
    cx.notify();
  }

  // k-spaces: "Collapse All" (IntelliJ's): every space's tab list folded in. Machines stay unfolded:
  // their spaces are the list.
  collapseAll(cx) {
    if (!this.tabsOpen.size) return;
    this.tabsOpen.clear();
    localStorage.setItem("k.tabs.open", "[]");
    this.cursor = null;
    cx.notify();
  }

  // k-spaces: its own menu (menu.js): the shipped items plus Copy path and Hide.
  menu(w, g) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "k-spaces", kind: "popup", width: 260, height: 400, props: { kMenu: "space",
      target: { id: w.id, name: w.name, machine: w.machine ?? null, path: place(w, panes()) || null, git: g ? (g.linked ? "linked" : "main") : null, hidden: hidden().spaces.includes(w.id) } } });
  }

  // k-spaces: a fold-out tab row's menu: Copy path (its first terminal's folder), Copy address, Rename, New tab, Close.
  tabMenu(w, c, lead) {
    openOverlay({ mod: "k-spaces", kind: "popup", width: 260, height: 220, props: { kMenu: "tab",
      target: { id: c.id, space: w.id, path: lead?.cwd || null, terminal: lead?.terminal || null } } });
  }

  // k-spaces: Hide / Unhide for this window: a machine (with its spaces) or a space. Hidden ones show,
  // dimmed, while the Spaces header's eye is on.
  isHidden(w) {
    const h = hidden();
    return h.spaces.includes(w.id) || h.machines.includes(w.machine ?? "");
  }

  orderingDue(now) {
    return this.ordering && now - this.ordering.at >= 1000
      && this.ordering.machines.every(name => machines().some(m => m.name === name && m.layout === "ready"));
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null }));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: n === kids.length - 1 ? "└─" : "├─" }));
    }
    // Simulate the batch so later indexes include earlier moves. An attempted
    // write can lose a sync conflict: allow the echo to settle before retrying.
    const order = sp.map(w => w.id);
    const target = out.map(r => r.w.id);
    const key = JSON.stringify([order, target, machines()]);
    if (order.every((id, i) => id === target[i])) {
      this.ordering = null;
    } else if (this.ordering?.key !== key || this.orderingDue(Date.now())) {
      const moved = new Set();
      this.ordering = { key, at: Date.now(), machines: [] };
      for (let i = 0; i < out.length; i++) {
        const from = order.indexOf(out[i].w.id);
        if (from === i) continue;
        run("space.move", { id: out[i].w.id, index: i + 1 });
        moved.add(out[i].w.machine ?? null);
        order.splice(i, 0, order.splice(from, 1)[0]);
      }
      this.ordering.machines = [...moved];
    }
    return out.filter(r => this.shown.has(r.w.id));
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    // k-spaces: hidden spaces and machines (this window) are left out unless the header's eye shows them.
    const showHidden = shared("k-spaces.showHidden") === true;
    const hiddenMachines = new Set(hidden().machines);
    const rows = this.ordered().filter(r => showHidden || !this.isHidden(r.w));
    const draw = (r) => (collapsed ? this.compact(r, t) : this.withTabs(r, t));
    // Where the active space's row lands among the children this returns: the list scrolls by its direct
    // children, and machine headers, login notes and loading rows count too.
    this.activeAt = -1;
    let before = 0;
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name), ...Object.keys(this.reconnecting)])]
      .filter(m => showHidden || !hiddenMachines.has(m)).sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => h_flex().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).items_center().when(collapsed, el => el.justify_center()).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) {
      if (loading(null) && !rows.length) return [loadingRow(null)];
      this.activeAt = rows.findIndex(r => r.w.active);
      return rows.map(draw);
    }
    const machineNames = [null, ...remote].filter(m => showHidden || !hiddenMachines.has(m ?? ""));
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const repair = this.reconnecting[m];
      const machine = this.machines.find(k => k.name === m) ?? repair?.machine;
      const connected = !m || machine?.state === "connected";
      const rebuilt = this.rebuilt(machine) || !!repair;
      const login = machine?.state === "needs_login" ? `hc machine login ${m}` : null;
      const folded = this.folded.has(m);
      const icon = svg(`mods/workspace-chrome/${m ? "server" : "monitor"}.svg`).size(13).flex_none();
      const badge = div().absolute().right(-3).bottom(-2).size(6).rounded(3).border_1().border_color(t.chrome).bg(connected ? t.ansi2 : t.dim);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .when(hiddenMachines.has(m ?? ""), el => el.opacity(0.5))
        // k-spaces: right-click: Agents (what's installed there), Hide / Unhide this machine in this window.
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "k-spaces", kind: "popup", width: 260, height: 100,
          props: { kMenu: "machine", target: { key: m ?? "", name: m ?? "This computer", hidden: hiddenMachines.has(m ?? "") } } }); })
        .when(collapsed, el => el.mt(4).w(RAIL_CELL).justify_center().rounded(6).tooltip(login ? `${m} needs a login: run ${login}. Click for Copy.` : m ? `${m} · ${connected ? "connected" : (machine?.state ?? "asleep").replace(/_/g, " ")}` : "This computer"))
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          if (collapsed && login) { openOverlay({ mod: "k-settings", kind: "dialog", width: 980, props: { section: "machines" } }); return; }
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .when(machine?.keeps_running_after_logout === false, el => el.child(div().id(`machine-logout-${m}`)
          .flex_none().text_color(t.blocked).tooltip("Agents stop when you disconnect. Click for the fix.")
          .on_click((_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "machine-add", kind: "dialog", width: 560 }); }).child("⚠")))
        .when(!collapsed, el => el.child(icon))
        .when(collapsed, el => el.child(div().relative().flex_none().child(icon).when(Boolean(m), el => el.child(badge))))
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected && !rebuilt && !login, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(rebuilt, el => el.child(h_flex().flex_none().gap(3).items_center()
            .child(div().max_w(140).truncate().child(repair?.error || "rebuilt ·"))
            .child(div().id(`machine-connect-${m}`).text_color(repair?.error ? t.blocked : t.muted)
              .hover(s => s.text_color(t.foreground))
              .tooltip(repair?.error || "This machine was rebuilt or replaced. Click to connect to the new one.")
              .on_click((_e, cx) => { cx.stop_propagation(); this.reconnect(machine, cx); })
              .child(repair?.busy ? "Connecting…" : "Connect"))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(4).hover(s => s.bg(t.hover).text_color(t.foreground))
            .tooltip("Open a repo or a new space").on_click((_e, cx) => { cx.stop_propagation(); repoMenu(m); }).child("+")))
          .child(div().size(6).rounded(3).flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/workspace-chrome/chevron-${folded ? "right" : "down"}.svg`).size(11).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(collapsed ? 0 : 8).gap(7).items_center().rounded(7)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => repoMenu(m))
        .when(collapsed, el => el.w(RAIL_CELL).rounded(6).justify_center().tooltip(`New space on ${m ?? "this computer"}`)
          .child(h_flex().size(18).rounded(5).border_1().border_color(t.dim).items_center().justify_center()
            .child(svg("mods/workspace-chrome/plus.svg").size(10))))
        .when(!collapsed, el => el.child(svg("mods/workspace-chrome/plus.svg").size(12)).child("New space there"));
      if (!collapsed && rebuilt) { before += 1; return [head]; }
      const cell = collapsed ? railCell : (el) => el;
      const guidance = !collapsed && login ? [v_flex().px(8).pb(6).gap(3).flex_none()
        .child(div().text_size(11).text_color(t.blocked).child("needs a login: run"))
        .child(h_flex().gap(5).items_center()
          .child(div().flex_1().min_w(0).truncate().tooltip(login).text_size(11).text_color(t.muted).child(login))
          .child(div().id(`machine-login-copy-${m}`).flex_none().px(5).py(2).rounded(4)
            .text_size(11).text_color(t.foreground).bg(t.raised).cursor_pointer().hover(s => s.bg(t.hover))
            .on_click((_e, cx) => { cx.stop_propagation(); cx.write_to_clipboard(login); this.copiedLogin = login; cx.notify(); })
            .child(this.copiedLogin === login ? "Copied" : "Copy")))] : [];
      const items = [cell(head), ...guidance, ...(folded ? [] : mine.length ? mine.map(draw) : [loading(m) ? loadingRow(m) : cell(empty)])];
      const first = folded ? -1 : mine.findIndex(r => r.w.active);
      if (first >= 0) this.activeAt = before + 1 + guidance.length + first;
      before += items.length;
      return items;
    });
  }

  // Only what's unusual, after the name: "herdr \u00b7 spike \u21912 \u21931". The repo or
  // branch goes when the name already says it (a worktree is named after its branch),
  // and master/main go: nearly every space is on one. When the row is full, it
  // and the name both start from their text's width and give way in proportion.
  gitTail(g, tree, name, t) {
    const raw = g.branch ?? "detached";
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = same(raw) || raw === "master" || raw === "main" ? "" : raw;
    const repo = tree || same(g.name) ? "" : g.name;
    const where = [repo, branch].filter(Boolean).join(" \u00b7 ");
    return h_flex()
      .flex_auto()
      .min_w(where ? SIDE_MIN : 0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(where), (el) => el.child(div().min_w(0).truncate().child(where)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  row({ w, i, g, tree }, t) {
    const on = w.active;
    const fromIndex = this.pressed === null ? -1 : spaces().findIndex(s => s.id === this.pressed);
    const colors = shared("space.colors") ?? {};
    const color = colors[w.id] ?? "ansi6";
    const fill = color.startsWith("#") ? color : (MARK[color] ?? t[color]);
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(8)
      .when(on, (el) => el.bg(t.selected))
      .when(!on, (el) => el.hover((s) => s.bg(t.hover)))
      .when(this.isHidden(w), (el) => el.opacity(0.5))
      .when(this.pressed === w.id && this.over !== w.id, (el) => el.opacity(0.5))
      .when(this.pressed !== null && this.over === w.id && this.pressed !== w.id, (el) => el.child(
        div().absolute().left(0).right(0).h(2).bg(t.accent)
          .when(fromIndex < i, line => line.bottom(0))
          .when(fromIndex > i, line => line.top(0)),
      ))
      .on_mouse_down("left", () => {
        this.pressed = w.id;
        this.over = w.id;
      })
      .on_mouse_move((_e, cx) => {
        const source = spaces().find(s => s.id === this.pressed);
        const over = source && (source.machine ?? null) === (w.machine ?? null) ? w.id : null;
        if (this.pressed !== null && this.over !== over) {
          this.over = over;
          cx.notify();
        }
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        const over = this.over;
        this.pressed = null;
        this.over = null;
        if (from !== null && over === w.id && from !== w.id) {
          const index = spaces().findIndex(s => s.id === w.id);
          if (index !== -1) run("space.move", { id: from, index: index + 1 });
        } else if (from === w.id) {
          // As VS Code's explorer: a click on the row selects the space and folds its tabs in or out.
          run("space.select", { id: w.id });
          this.toggleTabs(w);
        }
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w, g))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(22))
          .child(this.tabsChevron(w, t))
          .when(Boolean(tree), el => el.child(svg("mods/workspace-chrome/branch.svg").size(13).flex_none().text_color(t.dim)))
          .when(!tree, el => el.child(h_flex().size(18).flex_none().rounded(5).bg(fill).items_center().justify_center().text_size(10.5).font_bold().text_color("#ffffff").child([...w.name][0]?.toUpperCase() ?? "?")))
          .child(div().flex_initial().min_w(SIDE_MIN).truncate().text_color(t.foreground).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, t) : div().flex_1())
          .child(this.awayCount(w, t))
          .child(this.addTab(w, t)),
      );
  }

  // k-spaces: "+" after a space's name: a new tab there, a terminal or an agent (agents.js).
  addTab(w, t) {
    return div().id(`tab-add-${w.id}`).flex_none().size(20).rounded(4).flex().items_center().justify_center()
      .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .tooltip("New tab here: terminal or agent")
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); agentMenu(w); })
      .child(svg("mods/workspace-chrome/plus.svg").size(11));
  }

  // k-spaces: fold a space's tabs in or out (a click on its row, as in VS Code); remembered.
  toggleTabs(w) {
    this.tabsOpen.has(w.id) ? this.tabsOpen.delete(w.id) : this.tabsOpen.add(w.id);
    localStorage.setItem("k.tabs.open", JSON.stringify([...this.tabsOpen]));
  }

  // k-spaces: VS Code's fold arrow before a space's name.
  tabsChevron(w, t) {
    return svg(`mods/workspace-chrome/chevron-${this.tabsOpen.has(w.id) ? "down" : "right"}.svg`).size(11).flex_none().text_color(t.dim);
  }

  // k-spaces: how many of its tabs are put away, while they're folded in.
  awayCount(w, t) {
    const away = (w.tabs ?? []).filter(c => c.settled).length;
    if (!away || this.tabsOpen.has(w.id)) return div();
    return div().id(`tabs-away-${w.id}`).flex_none().px(3).text_size(11).text_color(t.dim).tooltip(`${away} put away`).child(String(away));
  }

  // k-spaces: the space row, then (when folded out) every tab in it, settled ones dimmed.
  withTabs(r, t) {
    const w = r.w;
    if (!this.tabsOpen.has(w.id)) return this.row(r, t);
    const ps = panes();
    // The same name and tag as its agent's row in k-agents: what another mod gave it in shared
    // "k-agents.rows" (kirin-tide: "<card>-<title>" and the card's status), else the tab's own name.
    const given = shared("k-agents.rows");
    const text = (v) => typeof v === "string" && v.trim() ? v.trim() : null;
    const rowGiven = (pane) => {
      if (!pane || !given || typeof given !== "object") return null;
      const a = agents().find(x => x.pane === pane.pane);
      const g = a ? given[a.address] : null;
      return g && typeof g === "object" ? g : null;
    };
    const tabRow = (c) => {
      const lead = ps.find(p => p.tab === c.id && p.program?.agent) ?? ps.find(p => p.tab === c.id);
      const extra = rowGiven(lead);
      const name = text(extra?.name) ?? (c.named ? c.name : (lead?.program?.name ?? c.name));
      const tag = text(extra?.tag);
      const tagColor = t[extra?.color] ?? t.dim;
      const shown = w.active && c.active;
      const marked = this.cursor === c.id;
      return h_flex().id(`tab-${c.id}`).h(24).flex_none().pl(55).pr(4).gap(6).items_center().rounded(6).text_size(12)
        .when(shown, el => el.bg(t.selected))
        .when(!shown, el => el.hover(s => s.bg(t.hover)))
        .border(1).border_color(marked ? t.border : t.chrome)
        // First press brings a tab back and leaves the keyboard with it; pressing the shown row again marks it for Del.
        .on_mouse_down("left", () => { if (shown) { this.cursor = c.id; this.handle.focus(); } else this.cursor = null; })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); this.tabMenu(w, c, lead); })
        .text_color(c.settled ? t.dim : shown ? t.foreground : t.muted)
        .on_click(() => {
          if (c.settled) run("tab.unsettle", { id: c.id });
          if (!w.active) run("space.select", { id: w.id });
          run("tab.select", { id: c.id });
        })
        .child(div().flex_1().min_w(0).truncate().when(c.settled, el => el.italic()).child(name))
        .when(Boolean(tag), el => el.child(div().id(`tab-tag-${c.id}`).flex_none().px(5).h(17).rounded(5).bg(tagColor + "26").text_size(10).font_semibold().text_color(tagColor).flex().items_center().child(tag)))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(11).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).flex_none().rounded(3).bg(t[c.status])))
        .when(c.settled, el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child("put away")))
        .child(div().id(`tab-close-${c.id}`).flex_none().size(18).rounded(4).flex().items_center().justify_center()
          .text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.blocked))
          .tooltip("Close tab: ends its programs (or click the shown row, then Del)")
          .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
          .on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); })
          .child(svg("mods/k-spaces/trash.svg").size(12)));
    };
    return v_flex().id(`space-wrap-${w.id}`).flex_none().gap(1).pb(2)
      .child(this.row(r, t))
      .children((w.tabs ?? []).map(tabRow));
  }

  compact({ w, i }, t) {
    return railCell(h_flex()
      .id(`space-${w.id}`)
      .relative()
      .w(RAIL_CELL)
      .h(26)
      .rounded(6)
      .justify_center()
      .items_center()
      .when(w.active, (el) => el.bg(t.selected))
      .when(!w.active, (el) => el.hover((s) => s.bg(t.hover)))
      .on_click(() => run("space.select", { id: w.id }))
      .child(div().text_color(w.active ? t.foreground : t.muted).child(String(i + 1)))
      .child(div().absolute().right(5).text_color(tone(t, w.status)).child(glyph(w.status))));
  }

  render() {
    if (this.repoView) return div().size_full().child(this.repoView);
    const t = theme();
    const collapsed = narrow();
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const kept = Object.fromEntries(Object.entries(shared("space.colors") ?? {}).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(shared("space.colors") ?? {}).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    const list = this.grouped(t, collapsed);
    const showHidden = shared("k-spaces.showHidden") === true;
    const h = hidden();
    const hiddenCount = h.machines.length + sp.filter(w => h.spaces.includes(w.id) && !h.machines.includes(w.machine ?? "")).length;
    // Bring the active space into view when it, or its place in the list, changes; a row already in view stays put.
    const active = sp.find(p => p.active)?.id;
    if (active !== this.revealed || this.activeAt !== this.revealedAt) {
      this.revealed = active;
      this.revealedAt = this.activeAt;
      if (this.activeAt >= 0) this.scroll.scroll_to_item(this.activeAt);
    }
    return v_flex().size_full().min_h(0).bg(t.chrome).text_size(13).track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape" && this.cursor) { this.cursor = null; cx.notify(); return; }
        if (e.key !== "delete" || !this.cursor) return;
        const id = this.cursor; this.cursor = null;
        if (sp.some(w => (w.tabs ?? []).some(c => c.id === id))) run("tab.close", { id });
        cx.stop_propagation(); cx.notify();
      })
      .child(h_flex().h(31).pl(16).pr(10).items_center().justify_between().text_size(11.5).text_color(t.dim)
        .when(collapsed, el => el.pl(0).pr(0).justify_center())
        .when(!collapsed, el => el.child(div().flex_1().child("Spaces")))
        .when(!collapsed, el => el.child(div().id("spaces-locate").size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Select the shown session: unfold its space and scroll to it")
          .on_click((_e, cx) => this.locate(cx)).child(svg("mods/k-spaces/locate.svg").size(14))))
        .when(!collapsed, el => el.child(div().id("spaces-collapse").size(26).flex_none().flex().items_center().justify_center().rounded(6)
          .hover(s => s.bg(t.hover).text_color(t.foreground)).tooltip("Collapse all: fold every space's tabs in")
          .on_click((_e, cx) => this.collapseAll(cx)).child(svg("mods/k-spaces/collapse.svg").size(14))))
        // k-spaces: how many are hidden in this window; click to show them (dimmed) or hide them again.
        .when(!collapsed && hiddenCount > 0, el => el.child(h_flex().id("spaces-hidden").h(22).px(6).gap(5).rounded(5).items_center().flex_none()
          .text_size(11).text_color(showHidden ? t.foreground : t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
          .tooltip(showHidden ? "Hide them again" : "Show hidden spaces and machines (this window)")
          .on_click(() => setShared("k-spaces.showHidden", !showHidden))
          .child(svg(`mods/k-spaces/${showHidden ? "eye" : "eye-off"}.svg`).size(12))
          .child(String(hiddenCount))))
        .child(div().id("space-new").size(26).flex_none().flex().items_center().justify_center().rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
          .on_click(() => {
            // k-spaces: with this computer hidden here, a new space goes to the first machine still shown.
            const hm = hidden().machines;
            const m = hm.includes("") && this.machines.find(k => k.state === "connected" && !hm.includes(k.name));
            // The same menu as a machine's "+": a repo, any folder (picked in a dialog), or an empty space.
            repoMenu(m ? m.name : null);
          }).child(svg("mods/workspace-chrome/plus.svg").size(14))))
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pb(14).overflow_y_scrollbar().mode("always").track_scroll(this.scroll)
        // A block above (another mod's) growing, or the window resizing, shrinks this list and can push the active space out.
        .on_size_change((_size, cx) => { if (this.activeAt >= 0) { this.scroll.scroll_to_item(this.activeAt); cx.notify(); } })
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; cx.notify(); })
        .children(list));
  }
}

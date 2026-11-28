// k-tabs (herdr-essentials): the shipped tab bar, but × puts a tab away (tab.settle) instead of ending it,
// and the bar lists the tabs you opened, whatever space or machine they are in (like VS Code's editor
// tabs), not the shown space's tabs: see open.js. A tab's right-click menu is menu.js (Close, Close Other
// Tabs, Close All Tabs, as IntelliJ). Files and Changes are on the
// status bar (k-status); Attach and Paste shot are k-attach's. With shared "k-tabs.multiline"
// (Settings → Look) the tabs wrap onto more lines and the bar grows to fit.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, ScrollHandle } from "gpui-base";
import { spaces, panes, run, openOverlay, theme, window, shared, layout, settings, props } from "herdr";
import { opened, neighbour, moved, cycled, trimmed, others } from "./open.js";
import TabMenu, { DO } from "./menu.js";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Same as the agents mod: drops a status glyph, keeps a leading bracket or quote.
const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}\p{Ps}\p{Pi}]+/u, "").replace(/^\[ [!.] \] /, "").trim();

// A tab Herdr named (unnamed, or after its program) follows its agent's live
// title, as the agents list does; a name the person gave stays.
function label(tab, lead) {
  const prog = lead?.program?.name;
  const base = tab.named ? tab.name : prog ?? "Terminal";
  if (!lead?.program?.agent) return base;
  const live = clean(lead.title);
  // clean() would strip a path's leading ~ or /: test the title with only its status glyph gone.
  const path = /^[~/]|^[A-Za-z]:\\/.test((lead.title ?? "").replace(/^[^\p{L}\p{N}~/]+/u, ""));
  const telling = live && live !== lead.terminal && live !== prog && !path && !live.includes("@") && live.toLowerCase() !== lead.program.key;
  return (tab.name === prog || !tab.named) && telling ? live : base;
}

// The bar's height with one line of tabs (the layout's own).
const LINE = 42;

export default class Tabs extends View {
  init(_props, cx) {
    // k-tabs: a tab's right-click menu is this mod again, as a popup (menu.js).
    if (props()?.kMenu) { this.menuView = cx.new(TabMenu, {}); return; }
    // What that menu last asked for (shared, so it outlives a restart): not to be done again.
    this.did = shared(DO)?.at ?? null;
    this.pressed = null;
    this.scroll = ScrollHandle.new();
    try { this.panels = JSON.parse(localStorage.getItem("panels") ?? "{}"); } catch { this.panels = {}; }
    if (!this.panels || typeof this.panels !== "object" || Array.isArray(this.panels)) this.panels = {};
    this.swipe = { acc: 0, steps: 0, at: 0, last: 0 };
    // k-tabs: the open tabs, left to right (ids from any space). null: never saved, so the first
    // render starts it with the shown space's tabs.
    try { this.open = JSON.parse(localStorage.getItem("open") ?? "null"); } catch { this.open = null; }
    if (!Array.isArray(this.open)) this.open = null;
    this.bar = [];
  }

  setOpen(list) {
    if (list === this.open) return;
    this.open = list;
    localStorage.setItem("open", JSON.stringify(list));
  }

  // Shows a tab of any space.
  go(entry) {
    if (!entry) return;
    if (!entry.space.active) run("space.select", { id: entry.space.id });
    run("tab.select", { id: entry.tab.id });
  }

  // The next / previous tab on the bar, wrapping.
  cycle(dir) {
    const ids = this.bar.map(e => e.tab.id);
    const to = cycled(ids, this.selected, dir);
    if (to && to !== this.selected) this.go(this.bar.find(e => e.tab.id === to));
  }

  // × (or a middle click): off the bar and put away; it keeps running. The shown one hands over to
  // its neighbour first. The only tab on the bar stays (something has to show).
  close(id) {
    const ids = this.bar.map(e => e.tab.id);
    if (id === this.selected) {
      const to = neighbour(ids, id);
      if (!to) return;
      // Until the neighbour shows, the closed one is still the shown tab: not to be opened again.
      this.closing = { id, until: Date.now() + 1000 };
      this.go(this.bar.find(e => e.tab.id === to));
    }
    this.setOpen(this.open.filter(x => x !== id));
    run("tab.settle", { id });
  }

  // Close Other Tabs: only that one stays on the bar (and shows); the rest are put away, still running.
  closeOthers(id) {
    const keep = this.bar.find(e => e.tab.id === id);
    const rest = others(this.bar.map(e => e.tab.id), id);
    if (!keep || !rest.length) return;
    if (this.selected !== id) {
      // Until it shows, the old shown tab is still the shown one: not to be opened again.
      if (this.selected) this.closing = { id: this.selected, until: Date.now() + 1000 };
      this.go(keep);
    }
    this.setOpen(this.open.filter(x => !rest.includes(x)));
    for (const x of rest) run("tab.settle", { id: x });
  }

  // Close All Tabs: something has to show, so the shown tab stays and the rest are put away.
  closeAll() {
    if (this.selected) this.closeOthers(this.selected);
  }

  // One tab per wheel notch. A touchpad or smooth-scrolling mouse sends many
  // small events per gesture: a short swipe or one smoothed notch (about
  // 25 px) switches one tab, a longer swipe keeps going a tab per 60 px, at
  // most one every 100 ms so each shows.
  wheel(e) {
    if (e.delta_lines) {
      if (e.delta_lines.y) this.cycle(e.delta_lines.y > 0 ? -1 : 1);
      return;
    }
    const s = this.swipe, now = Date.now();
    // Phases often arrive only as moves (a macOS touchpad included): a pause
    // or a turn starts a new gesture.
    if (e.touch_phase === "started" || now - s.at > 250 || e.delta.y * s.acc < 0) Object.assign(s, { acc: 0, steps: 0 });
    s.at = now;
    s.acc += e.delta.y;
    const need = s.steps ? 60 : 20;
    if (Math.abs(s.acc) < need || now - s.last < 100) return;
    s.acc -= Math.sign(s.acc) * need;
    s.steps++;
    s.last = now;
    this.cycle(e.delta.y > 0 ? -1 : 1);
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, panel, body, enabled) {
    if (!space || !panel) return;
    const now = panel.hidden ? null : body?.active ?? null;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id; this.pending = null;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) {
          this.pending = { want, until: Date.now() + 1000 };
          if (want) { run("layout.select", { stack: "panel-body", child: want }); run("layout.show", { id: "panel" }); }
          else run("layout.hide", { id: "panel" });
          return;
        }
      }
    }
    // Until the restore lands (or something else won), the old state isn't a choice.
    if (this.pending) {
      if (this.pending.want !== now && Date.now() < this.pending.until) return;
      this.pending = null;
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  render() {
    if (this.menuView) return div().size_full().child(this.menuView);
    const t = theme();
    const space = spaces().find(p => p.active);
    // k-tabs: the bar is the open tabs of every space, in the order they were opened or dragged to.
    const all = new Map();
    for (const sp of spaces()) for (const tab of sp.tabs ?? []) all.set(tab.id, { tab, space: sp });
    const now = space?.tabs?.find(tab => tab.active)?.id;
    if (this.closing && (this.closing.id !== now || Date.now() > this.closing.until)) this.closing = null;
    if (!this.open) this.setOpen((space?.tabs ?? []).filter(tab => !tab.settled || tab.active).map(tab => tab.id));
    if (now && this.closing?.id !== now) this.setOpen(trimmed(opened(this.open, now, this.selected), id => all.has(id)));
    // Settled tabs (put away with ×, here or in the sidebar) leave the bar; the shown one always stays.
    const shown = this.open.map(id => all.get(id)).filter(e => e && (!e.tab.settled || e.tab.id === now));
    this.bar = shown;
    const several = new Set(shown.map(e => e.space.id)).size > 1;
    const active = shown.findIndex(e => e.tab.id === now);
    const selected = shown[active]?.tab.id;
    if (selected !== this.selected || active !== this.selectedIndex) {
      this.selected = selected;
      this.selectedIndex = active;
      if (active >= 0) this.scroll.scroll_to_item(active);
    }
    // What the right-click menu asked for (menu.js), once.
    const ask = shared(DO);
    if (ask?.at && ask.at !== this.did) {
      this.did = ask.at;
      if (ask.what === "close") this.close(ask.id);
      else if (ask.what === "others") this.closeOthers(ask.id);
      else if (ask.what === "all") this.closeAll();
    }
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(26).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (entry, i) => {
      const c = entry.tab, on = i === active;
      const lead = panes().find(p => p.tab === c.id && p.program?.agent) ?? panes().find(p => p.tab === c.id);
      const program = lead?.program;
      const name = label(c, lead);
      return h_flex().id(`tab-${c.id}`).h(29).px(10).gap(7).rounded(7).items_center().flex_none().text_size(12.8)
        // A rename or status dot on this or an earlier tab can push the active one out.
        .when(i <= active && !multi, el => el.on_size_change((_size, cx) => { this.scroll.scroll_to_item(active); cx.notify(); }))
        .border(1).border_color(on ? t.border : t.chrome).bg(on ? t.raised : t.chrome).text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(t.hover))
        .on_hover((over, cx) => { if (over) this.over = c.id; else if (this.over === c.id) this.over = null; cx.notify(); })
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.pressed; this.pressed = null;
          // Dragging reorders the bar only, not the tabs in their spaces.
          if (from !== null && from !== i && shown[from]) { this.setOpen(moved(this.open, shown[from].tab.id, c.id)); cx.notify(); }
          else this.go(entry);
        })
        .on_mouse_down("middle", (_e, cx) => { cx.stop_propagation(); this.close(c.id); cx.notify(); })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openOverlay({ mod: "k-tabs", kind: "popup", width: 250, height: 260, props: { kMenu: true, target: { id: c.id, space: entry.space.id, count: shown.length } } }); })
        .tooltip(entry.space.machine ? `${entry.space.machine} · ${entry.space.name}` : entry.space.name)
        .when(Boolean(program?.icon), el => el.child(program.tint ? svg(program.icon).size(14).text_color(t.muted) : image(program.icon).size(14)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        // Tabs of several spaces on the bar: say whose each one is.
        .when(several, el => el.child(div().max_w(90).truncate().text_size(11).child(entry.space.name)))
        .when(c.status === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded(3).bg(t[c.status])))
        // × on the shown tab and on the one under the pointer; the others keep its room, so tabs don't shift.
        .when(shown.length > 1, el => el.child(div().id(`close-${c.id}`).size(16).flex_none().flex().items_center().justify_center().rounded(4).text_color(t.dim)
          .when(!(on || this.over === c.id), x => x.opacity(0))
          .hover(s => s.bg(t.border).text_color(t.foreground)).tooltip("Put away (it keeps running)")
          .on_mouse_down("left", stop).on_mouse_up("left", stop).on_click((_e, cx) => { cx.stop_propagation(); this.close(c.id); cx.notify(); }).child(svg("mods/pane/close.svg").size(12))));
    };
    const root = layout(), sidebar = find(root, "sidebar"), w = window();
    // Old saved rails and a dragged-narrow sidebar can be smaller than the window buttons.
    const lightsPadding = w?.platform === "macos" && w.titlebar === "none" && !w.fullscreen && root?.traffic_lights
      ? Math.max(10, (root.traffic_lights[0] + 64) / settings().zoom - (sidebar?.hidden ? 0 : sidebar?.size?.px ?? 0))
      : 10;
    const panel = find(root, "panel"), body = find(root, "panel-body");
    const enabled = shared("workspace.panels") ?? ["files", "changes"];
    this.syncPanel(space, panel, body, enabled);
    // k-tabs: several lines when asked for; the block is as tall as the lines need (one line: 42).
    const multi = shared("k-tabs.multiline") === true;
    const block = find(root, "tabs")?.size?.px;
    const fit = (height) => {
      const want = multi ? Math.max(LINE, Math.round(height) + 12) : LINE;
      if (block != null && Math.abs(block - want) >= 1) run("layout.resize", { id: "tabs", px: want });
    };
    if (!multi) fit(0);
    const tabs = multi
      // Wrapping: no scrolling, the block grows instead (fit).
      ? h_flex().id("tab-wrap").flex_1().min_w(0).flex_wrap().items_center().gap(3)
        .on_size_change((size) => fit(size.height))
      : h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(3).overflow_x_scrollbar().track_scroll(this.scroll)
        .on_size_change((_size, cx) => { if (active >= 0) { this.scroll.scroll_to_item(active); cx.notify(); } });
    return h_flex().size_full().min_w(0).px(10).pl(lightsPadding).gap(3).items_center().bg(t.chrome).border_b(1).border_color(t.border)
      .when(multi, el => el.items_start().py(6))
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(tabs.children(shown.map(item)))
      .child(button("tab-new", "+", () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 })))
      .when(w?.buttons, el => el.child(button("minimize", w.platform === "windows" ? svg("mods/k-tabs/win-min.svg").size(16) : "−", () => run("window.minimize")))
        .child(button("maximize", w.platform === "windows" ? svg(`mods/k-tabs/${w.maximized ? "win-restore" : "win-max"}.svg`).size(16) : "□", () => run("window.maximize")))
        .child(button("close-window", w.platform === "windows" ? svg("mods/k-tabs/win-close.svg").size(16) : svg("mods/pane/close.svg").size(13), () => run("window.close"))));
  }
}

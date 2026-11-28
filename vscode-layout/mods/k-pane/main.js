// k-pane (herdr-essentials): Herdr's built-in `pane` header (herdr-app 0.1.18, Apache-2.0), plus
// what other mods put in it: shared "k-pane.chips", see core.js. A header without chips is the
// built-in one, except: an agent whose model is known shows the model's icon (maker and tier, tinted
// by effort: model.js, the same icons as k-agents) instead of the program's icon and name; then
// where it is: the machine (another one only) and the space (the repo). The folder is no longer
// written out: it is in the tooltip of all that. Layout: { "pane": { "header": { "content": { "mod": "k-pane" } } } }.
// Props from the app: { pane, terminal }. Click: focus the pane; a chip with a url: open it.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, terminals, spaces, props, run, theme, home, layout, shared, openOverlay } from "herdr";
import { chipsFor, modsIn, placeOf, switchKind } from "./core.js";
import ModelMenu from "./switch.js";
import { modelOf, effortLevel, modelTip } from "./model.js";

// Match the first visible tab frame, including the active child of a stack.
function paneFrame(node) {
  if (!node || node.hidden) return null;
  if (node.content?.tab && node.content.pane) return node.content.pane;
  let children = node.children ?? [];
  if (node.type === "stack") {
    const visible = children.filter(child => !child.hidden);
    children = [visible.find(child => child.id === node.active) ?? visible[0]];
  }
  for (const child of children) {
    const frame = paneFrame(child);
    if (frame) return frame;
  }
  return null;
}

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// The model's icon on an effort tint (as in k-agents).
function modelIcon(m) {
  const c = m.color, e = m.effort, level = effortLevel(e);
  return div().size(20).flex_none().flex().items_center().justify_center().rounded(6)
    .when(level === 1, (el) => el.bg(c + "24"))
    .when(level === 2, (el) => el.bg(c + "44"))
    .when(level === 3, (el) => el.bg(c + (e === "max" ? "66" : "44")).border_1().border_color(e === "max" ? c : c + "99"))
    .child(svg(m.icon).size(14).flex_none().text_color(c));
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init(_p, cx) {
    this.hovered = false;
    // The model menu is a popup copy of this mod (switch.js).
    if (props()?.kModel) this.menuView = cx.new(ModelMenu, {});
  }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(3)
      .rounded(4)
      .text_color(t.dim)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        run(command, args);
      })
      .child(svg(`mods/pane/${icon}.svg`).size(14));
  }

  chip(t, pane, c) {
    const color = t[c.color] ?? t.dim;
    return h_flex()
      .id(`k-pane-chip-${pane}-${c.by}`)
      .flex_1()
      .min_w(0)
      .h(22)
      .px(6)
      .gap(6)
      .items_center()
      .rounded(5)
      .when(Boolean(c.tip || c.url), el => el.tooltip([c.tip, c.url].filter(Boolean).join("\n")))
      .when(Boolean(c.url), el => el
        .cursor_pointer()
        .hover((s) => s.bg(t.hover))
        .on_click((_e, cx) => {
          cx.stop_propagation();
          cx.open_url(c.url);
        }))
      .when(Boolean(c.label), el => el.child(div().flex_none().text_color(t.muted).child(c.label)))
      .when(Boolean(c.text), el => el.child(div().min_w(0).truncate().text_color(t[c.tone] ?? t.foreground).child(c.text)))
      .when(Boolean(c.tag), el => el.child(div().flex_none().px(5).h(17).rounded(5).bg(color + "26").text_size(10).font_semibold().text_color(color).flex().items_center().child(c.tag)));
  }

  render(cx) {
    if (this.menuView) return this.menuView;
    const t = theme();
    const p = this.me();
    if (!p) return div();
    // The model's icon says who makes it and which tier: with it, the program's name ("Claude
    // Code") is left out; a name the terminal was given stays.
    const m = modelOf(terminals().find((x) => x.address === p.terminal), "mods/k-pane");
    const known = Boolean(m?.icon);
    const name = p.name || (known ? "" : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell");
    const kind = switchKind(p.program);
    let pic = known ? modelIcon(m) : icon(p.program, 14, t.dim);
    // Claude Code / Codex: the icon opens the model menu (switch.js).
    if (pic && kind) pic = div().id(`pane-model-${p.pane}`).flex_none().rounded(6).cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        openOverlay({ mod: "k-pane", kind: "popup", width: 210, height: kind === "claude" ? 284 : 40,
          props: { kModel: { terminal: p.terminal, kind, model: m?.kind ?? null, effort: m?.effort ?? null } } });
      })
      .child(pic);
    const at = placeOf(spaces(), p.tab);
    const tip = [known ? [p.program?.name, modelTip(m)].filter(Boolean).join(" \u00b7 ") : "", folder(p.cwd)].filter(Boolean).join("\n");
    const st = p.status;
    const pane = p.pane;
    const shown = layout();
    const bottom = paneFrame(shown)?.header?.position === "bottom";
    const chips = chipsFor(shared("k-pane.chips"), p.terminal, modsIn(shown));
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(10)
      .gap(8)
      .items_center()
      .bg(t.background)
      .when(bottom, el => el.border_t(1))
      .when(!bottom, el => el.border_b(1))
      .border_color(t.border)
      .text_size(12)
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_click(() => run("pane.focus", { pane }))
      // The model menu's icon is outside the tooltip: the tooltip would cover the menu.
      .when(Boolean(pic) && Boolean(kind), (el) => el.child(pic))
      .child(h_flex().id(`pane-who-${pane}`).flex_none().gap(8).items_center()
        .when(Boolean(tip), el => el.tooltip(tip))
        .when(Boolean(pic) && !kind, (el) => el.child(pic))
        .when(Boolean(at.machine), el => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(at.machine)))
        .when(Boolean(at.space), el => el.child(div().flex_none().truncate().max_w(200).font_medium().text_color(t.foreground).child(at.space)))
        .when(Boolean(name) && name !== at.space, el => el.child(div().flex_none().truncate().max_w(260).text_color(at.space ? t.muted : t.foreground).when(!at.space, x => x.font_medium()).child(name))))
      .children(chips.map(c => this.chip(t, pane, c)))
      // Without chips: keep the status and the buttons at the right end.
      .when(chips.length === 0, el => el.child(div().flex_1()))
      .when(st === "working", el => el.child(svg("mods/workspace-chrome/spinner.svg").size(12).flex_none().text_color(t.working).spin(900)))
      .when(st === "blocked", el => el.child(div().flex_none().px(6).h(18).flex().items_center().rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).child("Needs you")))
      .when(st === "done", el => el.child(div().size(7).flex_none().rounded(4).bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}

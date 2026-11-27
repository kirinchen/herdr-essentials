// k-tabs (herdr-essentials): a tab's right-click menu, in place of the shipped `menu` for tabs. As in
// IntelliJ's editor tabs: Close, Close Other Tabs, Close All Tabs. Closing here is what × does: off the
// bar and put away (tab.settle), the program keeps running and the sidebar brings it back. "End tab" is
// the shipped Close (tab.close), which stops the program.
// The menu is another copy of this mod (a popup): it can't reach the bar's list, so it leaves what to
// do in shared "k-tabs.do" ({ what, id, at }) and the bar does it (main.js).
// ↑/↓ move, Enter runs, Esc closes, as in the shipped menu.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, theme, keys, setShared } from "herdr";

export const DO = "k-tabs.do";
const ask = (what, id) => setShared(DO, { what, id, at: Date.now() });

// An item: { label, icon, act(), hint?, command? (its key is the hint), rule? (a line above it), off? }.
export function items(p) {
  const tg = p?.target ?? {};
  const icon = (n) => `mods/workspace-chrome/${n}.svg`;
  const alone = !(tg.count > 1);
  return [
    { label: "Close", icon: icon("x"), hint: alone ? "the only tab" : "keeps running", off: alone, act: () => ask("close", tg.id) },
    { label: "Close Other Tabs", icon: icon("x"), off: alone, act: () => ask("others", tg.id) },
    { label: "Close All Tabs", icon: icon("x"), hint: "but the shown one", off: alone, act: () => ask("all", tg.id) },
    { label: "Rename", icon: icon("square-pen"), command: "tab.rename", act: () => run("tab.rename", { id: tg.id }), rule: true },
    { label: "New tab", icon: icon("plus"), command: "tab.new", act: () => run("tab.new", { space: tg.space }) },
    { label: "End tab", icon: icon("x"), hint: "stops the program", act: () => run("tab.close", { id: tg.id }), rule: true },
  ];
}

const shortcut = (name) => (name ? keys().find((b) => b.section === "global" && b.action === name)?.keys ?? "" : "");

export default class TabMenu extends View {
  init(_p, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    cx.timer.after(20, () => this.handle.focus());
  }

  choose(i) {
    const it = items(props())[i];
    if (!it || it.off) return;
    const id = props()?.overlay;
    it.act();
    closeOverlay(id);
  }

  render() {
    const t = theme();
    const list = items(props());
    const step = (d) => { for (let n = 0; n < list.length; n += 1) { this.at = (this.at + d + list.length) % list.length; if (!list[this.at].off) return; } };
    if (list[this.at]?.off) step(1);
    return v_flex().id("k-tab-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") step(1);
        else if (e.key === "up") step(-1);
        else if (e.key === "enter") return this.choose(this.at);
        else if (e.key === "escape") return closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => v_flex()
        .when(i > 0 && Boolean(it.rule), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`k-tmi-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(it.off ? t.dim : t.foreground)
          .when(i === this.at && !it.off, (el) => el.bg(t.selected))
          .when(!it.off, (el) => el.hover((s) => s.bg(t.hover)))
          .on_click(() => this.choose(i))
          .child(svg(it.icon).size(14).flex_none().text_color(it.off ? t.dim : t.muted))
          .child(div().flex_none().child(it.label))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(it.hint ?? shortcut(it.command))))));
  }
}

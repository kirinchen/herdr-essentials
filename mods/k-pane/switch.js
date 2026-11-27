// k-pane (herdr-essentials): the model menu, opened by clicking the model icon in a pane header.
// It is another copy of this mod (a popup, props().kModel = { terminal, kind, model, effort }); a
// choice is typed into the agent with `hc send` (paste + Enter; hc waits for a draft you are
// typing and refuses a program that is asking you something). ↑/↓ move, Enter runs, Esc closes.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { props, closeOverlay, theme, exec, notify } from "herdr";
import { switchItems, targetOf } from "./core.js";

async function send(address, text) {
  const { on, id } = targetOf(address);
  const r = await exec("hc", ["send", id, text], { on, timeout: 20000 });
  if (r?.code !== 0) notify({ title: `Couldn't send ${text}`, body: String(r?.stderr || r?.stdout || "hc send failed").trim().slice(0, 300), level: "error" });
}

export default class ModelMenu extends View {
  init(_p, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    cx.timer.after(20, () => this.handle.focus());
  }

  list() {
    const k = props()?.kModel ?? {};
    return switchItems(k.kind, { kind: k.model, effort: k.effort });
  }

  choose(i) {
    const it = this.list()[i];
    if (!it) return;
    const id = props()?.overlay;
    send(props()?.kModel?.terminal, it.send);
    closeOverlay(id);
  }

  render() {
    const t = theme();
    const list = this.list();
    return v_flex().id("k-model-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at - 1 + list.length) % list.length;
        else if (e.key === "enter") return this.choose(this.at);
        else if (e.key === "escape") return closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => v_flex()
        .when(i > 0 && Boolean(it.rule), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`k-mm-${i}`).h(29).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click(() => this.choose(i))
          .child(div().w(14).flex_none().when(Boolean(it.now), (el) => el.child(svg("mods/k-pane/check.svg").size(13).text_color(t.accent ?? t.foreground))))
          .child(div().flex_none().child(it.label))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(it.hint ?? "")))));
  }
}

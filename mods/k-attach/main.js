// k-attach (herdr-essentials): two buttons for any layout. "Attach" picks files with the system
// dialog and pastes their paths into the focused terminal (no Enter), the way dropping files does;
// "Paste shot" shows while the clipboard holds an image, saves it as a PNG and pastes that path.
// Claude Code turns a pasted image path into an image. Commands (bind keys to them):
// k-attach.attach, k-attach.paste-shot. Layout: a block { "mod": "k-attach" } about 190 px wide,
// e.g. at the right end of the status bar; the buttons sit at its right edge.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { theme, focused, nextCommand } from "herdr";
import { attach } from "./attach.js";
import { watchClipboard, pasteShot } from "./shot.js";

export default class Attach extends View {
  init(_p, cx) {
    this.clip = false;
    cx.spawn(async (cx) => watchClipboard((on) => { this.clip = on; cx.notify(); },
      (ms) => new Promise((done) => cx.timer.after(ms, () => done()))));
    cx.spawn(async (cx) => {
      for (;;) {
        const command = await nextCommand();
        if (command === "attach") cx.spawn(async (cx) => attach(cx));
        else if (command === "paste-shot") cx.spawn(async (cx) => pasteShot(cx));
      }
    });
  }

  render(cx) {
    const t = theme();
    const terminal = Boolean(focused()?.terminal);
    const button = (id, text, icon, tip, act) => h_flex().id(id).h(22).px(7).gap(5).flex_none().items_center().rounded(5)
      .bg(t.chrome).text_color(t.muted).hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .tooltip(tip)
      .on_click((_e, cx) => { cx.stop_propagation(); cx.spawn(async (cx) => act(cx)); })
      .child(svg(icon).size(13)).child(text);
    return h_flex().size_full().px(8).gap(2).items_center().justify_end().bg(t.chrome).border_t(1).border_color(t.border).text_size(11.8)
      .when(terminal && this.clip, (el) => el.child(button("paste-shot", "Paste shot", "mods/k-attach/image.svg", "Paste the clipboard image into the terminal", pasteShot)))
      .when(terminal, (el) => el.child(button("attach", "Attach", "mods/k-attach/paperclip.svg", "Attach files: paste their paths into the terminal", attach)));
  }
}

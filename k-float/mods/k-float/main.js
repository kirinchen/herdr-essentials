// k-float demo (herdr-essentials, ADR 0005): the smallest mod that uses float.js. It opens one
// desktop window with a counter; the page's buttons come back here as events, and the count
// goes out again as data. The SDK itself is float.js: this file is only an example of using it.
// Open it:  herdr-app do mod.open --name k-float
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, checking } from "herdr";
import { float } from "./float.js";

const ID = "k-float-demo";
const PAGE = `<!doctype html><meta charset="utf-8">
<body style="margin:0;height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;font:15px system-ui,sans-serif;background:#1f2430;color:#e6e6e6">
  <div>count <b id="n" style="font-size:28px">0</b></div>
  <div>
    <button onclick="float.send({ add: -1 })">−</button>
    <button onclick="float.send({ add: 1 })">+</button>
    <input id="say" placeholder="type, Enter" size="12">
  </div>
  <div id="echo" style="font-size:12px;color:#9aa4b2">&nbsp;</div>
  <script>
    float.onData((d) => { n.textContent = d.count; echo.textContent = d.echo || "\\u00a0"; });
    say.addEventListener("keydown", (e) => { if (e.key === "Enter") { float.send({ say: say.value }); say.value = ""; } });
  </script>
</body>`;

export default class FloatDemo extends View {
  init(_p, cx) {
    this.count = 0; this.echo = ""; this.open = false; this.log = []; this.error = null;
    if (checking()) return;
    float.listen(cx, ID, (e) => {
      this.log = [...this.log, e.type === "message" ? `message ${JSON.stringify(e.data)}` : e.type + (e.by ? ` (${e.by})` : "") + (e.message ? `: ${e.message}` : "")].slice(-6);
      if (e.type === "closed") this.open = false;
      if (e.type === "message") {
        if (typeof e.data?.add === "number") this.count += e.data.add;
        if (typeof e.data?.say === "string") this.echo = `mod got: ${e.data.say}`;
        return float.update(ID, { data: { count: this.count, echo: this.echo } });
      }
    });
    cx.spawn(async (cx) => { this.open = (await float.get(ID)) != null; cx.notify(); });
  }

  toggle(cx) {
    cx.spawn(async (cx) => {
      try {
        if (this.open) await float.close(ID);
        else await float.open({ id: ID, title: "k-float demo", width: 300, height: 170, html: PAGE, data: { count: this.count, echo: this.echo } });
        this.open = !this.open; this.error = null;
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
    });
  }

  async close() { await float.close(ID); }

  render() {
    const t = theme(), p = props() ?? {};
    const button = (id, label, action) => div().id(id).h(26).px(10).flex().items_center().rounded(6).cursor_pointer().border_1().border_color(t.border)
      .bg(t.raised).hover((s) => s.bg(t.hover)).on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    return v_flex().id("k-float-demo").w(300).rounded(10).overflow_hidden().bg(t.popover ?? t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(h_flex().h(40).px(12).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().flex_1().font_semibold().child("Float demo"))
        .child(button("k-float-demo-toggle", this.open ? "Close window" : "Open window", (_e, cx) => this.toggle(cx)))
        .when(Boolean(p.overlay), (el) => el.child(button("k-float-demo-x", "✕", () => closeOverlay(p.overlay)))))
      .child(v_flex().p(12).gap(4)
        .child(div().child(`count ${this.count}`))
        .child(div().text_size(11).text_color(this.error ? t.blocked : t.dim).child(this.error ?? "A desktop window, on top of every program. Its buttons answer here."))
        .children(this.log.map((line) => div().text_size(11).text_color(t.muted).truncate().child(line))));
  }
}

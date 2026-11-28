// k-note (herdr-essentials, ADR 0005; the first use of k-float): a note on the desktop, on top of
// every program, also while Herdr is minimized. The note is a file,
//   <App home>/data/k-note/note.md
// so an agent or a script writes to it and the note follows; typing in the note saves the file.
// This small window inside Herdr is its switch: while it is open the note is on the desktop,
// closing either one closes both. The desktop window itself comes from float.js (the k-float SDK).
// Open it:  herdr-app do mod.open --name k-note     (bind a key in Settings → Keys)
import { View, div } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { theme, props, closeOverlay, appHome, readTextFile, writeTextFile, watchFolder, checking } from "herdr";
import * as fs from "fs/promises";
import { float, sleep } from "./float.js";   // a copy of mods/k-float/float.js (a mod can only import from its own folder); tests/k-float.test.js keeps them equal

const ID = "k-note";
const folder = () => `${appHome().replace(/[\\/]+$/, "")}/data/k-note`;
const file = () => `${folder()}/note.md`;

// The page: one text area. What is typed goes to the mod (which saves the file) a moment after
// the last key; text arriving from the file replaces it, unless it is what was just typed.
// No system title bar: the top strip, in the note's own color, moves the window; its buttons show
// when the pointer is over the note. The outer few pixels resize it.
const PAGE = `<!doctype html><meta charset="utf-8">
<style>
  html, body { margin: 0; height: 100%; background: #fff7c2; overflow: hidden; }
  body { display: flex; flex-direction: column; font: 14px/1.5 system-ui, "Noto Sans CJK TC", "Microsoft JhengHei", sans-serif; }
  #bar { flex: none; height: 22px; display: flex; justify-content: flex-end; align-items: center; gap: 2px; padding: 0 4px; cursor: move; }
  #bar button { width: 22px; height: 18px; border: 0; border-radius: 4px; padding: 0; background: transparent; color: #8a7a2e;
    font: 13px/18px system-ui, sans-serif; cursor: pointer; opacity: 0; transition: opacity .15s; }
  body:hover #bar button { opacity: 1; }
  #bar button:hover { background: #f1e6a6; color: #3b3200; }
  textarea { flex: 1; box-sizing: border-box; width: 100%; border: 0; outline: 0; resize: none; padding: 0 12px 10px;
    background: transparent; color: #3b3200; font: inherit; }
</style>
<div id="bar" data-float-drag><button id="min" title="Minimize">–</button><button id="x" title="Close">✕</button></div>
<textarea id="note" spellcheck="false" placeholder="Note"></textarea>
<script>
  min.onclick = () => float.minimize();
  x.onclick = () => float.close();
  let sent = null, timer = 0;
  float.onData((d) => {
    if (typeof d.text !== "string" || d.text === note.value || d.text === sent) return;
    const at = note.selectionStart;
    note.value = d.text;
    if (document.activeElement === note) note.setSelectionRange(at, at);
  });
  note.addEventListener("input", () => {
    clearTimeout(timer);
    timer = setTimeout(() => { sent = note.value; float.send({ text: sent }); }, 350);
  });
</script>`;

export default class Note extends View {
  init(_p, cx) {
    this.text = null;          // the file as last read or written here
    this.error = null; this.through = false; this.minimized = false;
    if (checking()) return;
    float.listen(cx, ID, (e, cx) => this.event(e, cx));
    cx.spawn(async (cx) => {
      try {
        await fs.mkdir(folder(), { recursive: true });
        this.text = await readTextFile(file());
        if (this.text == null) { await writeTextFile(file(), "", null); this.text = ""; }
        let place = {};
        try { place = JSON.parse(localStorage.getItem("place") ?? "{}"); } catch {}
        // Opaque while in use; see-through while the person works in a window under it.
        await float.open({ id: ID, title: "Note", width: 280, height: 220, ...place, html: PAGE, data: { text: this.text },
          frame: false, behindOpacity: 0.35 });
      } catch (e) { this.error = String(e?.message ?? e); }
      cx.notify();
      // The file changed (an agent, a script, an editor): show it.
      for (;;) {
        const began = Date.now();
        try {
          const changed = watchFolder(folder());
          await this.load();
          cx.notify();
          await changed;
        } catch (e) { this.error = String(e?.message ?? e); cx.notify(); }
        if (Date.now() - began < 100) await sleep(cx, 500); // a watch that can't wait must not become a busy loop
      }
    });
  }

  async load() {
    const text = (await readTextFile(file())) ?? "";
    if (text === this.text) return;
    this.text = text;
    await float.update(ID, { data: { text } });
  }

  async event(e, cx) {
    if (e.type === "message" && typeof e.data?.text === "string") {
      if (e.data.text === this.text) return;
      try {
        // `expected`: if someone else wrote the file since we read it, theirs wins and is shown.
        await writeTextFile(file(), e.data.text, this.text);
        this.text = e.data.text; this.error = null;
      } catch { await this.load(); }
    } else if (e.type === "moved" || e.type === "resized") {
      const spec = await float.get(ID);
      if (spec) localStorage.setItem("place", JSON.stringify({ x: spec.x, y: spec.y, width: spec.width, height: spec.height }));
    } else if (e.type === "minimized" || e.type === "restored") {
      this.minimized = e.type === "minimized"; cx.notify();
    } else if (e.type === "closed" && e.by === "user") {
      const overlay = props()?.overlay;
      if (overlay) closeOverlay(overlay);
    } else if (e.type === "error" || e.type === "warning") {
      this.error = e.message;
    }
  }

  async close() { await float.close(ID); }

  render() {
    const t = theme(), p = props() ?? {};
    const button = (id, label, action, on) => div().id(id).h(26).px(10).flex().items_center().rounded(6).cursor_pointer().border_1()
      .border_color(on ? t.accent : t.border).bg(t.raised).hover((s) => s.bg(t.hover))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation()).on_click(action).child(label);
    const lines = (this.text ?? "").split("\n").filter((l) => l.trim()).length;
    return v_flex().id("k-note").w(280).rounded(10).overflow_hidden().bg(t.popover ?? t.background).border_1().border_color(t.border)
      .text_color(t.foreground).text_size(13)
      .child(h_flex().h(40).px(12).gap(8).items_center()
        .child(div().flex_1().font_semibold().child("Note"))
        .when(this.minimized, (el) => el.child(button("k-note-show", "Show", (_e, cx) => {
          this.minimized = false; cx.notify();
          cx.spawn(async () => { await float.update(ID, { minimized: false }); });
        }, true)))
        .child(button("k-note-through", "Click-through", (_e, cx) => {
          this.through = !this.through; cx.notify();
          cx.spawn(async () => { await float.update(ID, { clickThrough: this.through }); });
        }, this.through))
        .when(Boolean(p.overlay), (el) => el.child(button("k-note-x", "✕", () => closeOverlay(p.overlay)))))
      .child(div().px(12).pb(10).text_size(11).text_color(this.error ? t.blocked : t.dim)
        .child(this.error ?? (this.minimized ? `Minimized · Show brings it back · ${lines} line${lines === 1 ? "" : "s"}`
          : `On the desktop, always on top · ${lines} line${lines === 1 ? "" : "s"} · data/k-note/note.md`)));
  }
}

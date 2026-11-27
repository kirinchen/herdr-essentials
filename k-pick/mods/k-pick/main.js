// k-pick (herdr-essentials): point at a part of the window for an agent, like the web DevPick
// (Ctrl+F12 there). Herdr draws natively, so there's no DOM to ask: a transparent layer over the
// whole window works out which layout block is under the pointer from layout() (rows, columns,
// px / weight sizes, hidden, stacks), outlines it, and on a click copies a locator such as
//   layout=k-main | block=sidebar-footer | mod=k-chrome | file=mods/k-chrome/main.js | path=root > sidebar > sidebar-footer | at=(52,1430) in block (44,12) of 268×69 | shot=…png
// with a window shot (outline and click mark in it) for the agent to look at. Esc leaves.
// Open it: herdr-app do mod.open --name k-pick.
// k-float's desktop windows aren't Herdr's window: this layer can't see into them. While it is open
// it leaves a flag file (<App home>/data/k-float/pick, kept fresh) and the k-float helper has each window's page
// pick for itself: outline under the pointer, a click copies `float=<id> | selector=… | text=… | at=…`
// (no shot). The helper then drops the flag and writes data/k-float/picked, which closes this layer.
// Dialogs and popups aren't in layout(): `herdr-app status` names the open ones, their mod.json
// gives the size (a dialog sits centered; k-settings reports its own height in shared "k-pick.sizes"),
// and a pick inside one reports that mod. While a dialog is open a click beside it closes it before
// this layer sees the click, so there the pick is Space / Enter at the pointer.
import { View, div } from "gpui-kit";
import { h_flex } from "gpui-base";
import * as fs from "fs/promises";
import { theme, layout, shared, props, closeOverlay, exec, appHome, readTextFile, notify, window, checking, openOverlay } from "herdr";

const sep = () => (window()?.platform === "windows" ? "\\" : "/");

// Every block's rectangle in logical px, parents before children; `depth` for the innermost pick.
function rects(node, x, y, w, h, out = [], depth = 0, path = []) {
  if (!node || node.hidden) return out;
  const here = [...path, node.id ?? node.type];
  out.push({ id: node.id, type: node.type, mod: node.content?.mod, terminal: node.content?.terminal, x, y, w, h, depth, path: here });
  const kids = (node.children ?? []).filter((c) => c && !c.hidden);
  if (node.type === "stack") {
    const shown = kids.find((c) => c.id === node.active) ?? kids[0];
    if (shown) rects(shown, x, y, w, h, out, depth + 1, here);
    return out;
  }
  if (node.type !== "row" && node.type !== "column") return out;
  const across = node.type === "row";
  const pad = typeof node.padding === "number" ? node.padding : 0;
  x += pad; y += pad; w -= 2 * pad; h -= 2 * pad;
  const between = (node.gap ?? 0) + (node.divider?.width ?? 0);
  const total = (across ? w : h) - between * Math.max(0, kids.length - 1);
  const clamp = (c, v) => Math.max(c.min ?? 0, Math.min(c.max ?? Infinity, v));
  const fixed = kids.map((c) => (c.size?.px != null ? clamp(c, c.size.px) : null));
  const left = Math.max(0, total - fixed.reduce((a, v) => a + (v ?? 0), 0));
  const weights = kids.map((c, i) => (fixed[i] != null ? 0 : c.size?.weight ?? 1));
  const sum = weights.reduce((a, v) => a + v, 0) || 1;
  let at = across ? x : y;
  kids.forEach((c, i) => {
    const len = fixed[i] ?? (left * weights[i]) / sum;
    if (across) rects(c, at, y, len, h, out, depth + 1, here);
    else rects(c, x, at, w, len, out, depth + 1, here);
    at += len + between;
  });
  return out;
}

// The innermost block under a point.
function hit(list, px, py) {
  let best = null;
  for (const r of list) if (px >= r.x && px < r.x + r.w && py >= r.y && py < r.y + r.h && (!best || r.depth >= best.depth)) best = r;
  return best;
}

// An open overlay's rectangle in the window, or null when its place can't be known
// (a popup at the pointer, a dialog that sizes to its content and doesn't report it).
function overlayRect(o, W, H) {
  const spec = o.spec ?? {};
  const len = (v, of) => (typeof v === "number" ? (v <= 1 ? v * of : v) : null);
  const w = o.size?.width ?? len(spec.width, W), h = o.size?.height ?? len(spec.height, H);
  if (w == null || h == null) return null;
  const kind = spec.kind ?? "dialog";
  if (kind === "dialog") return { x: (W - w) / 2, y: (H - h) / 2, w, h };
  if (kind === "popup" && spec.at === "top") return { x: (W - w) / 2, y: spec.offset ?? 0, w, h };
  if (spec.at && typeof spec.at === "object") return { x: spec.at.x, y: spec.at.y, w, h };
  return null;
}

// The pointer in window coordinates (the gpui window, which herdr's `window` import shadows).
function mouseAt() {
  try { const p = globalThis.window?.mouse_position?.(); return p && Number.isFinite(p.x) ? { x: p.x, y: p.y } : null; } catch { return null; }
}

// k-float's flag and result files (see the top). The flag is written again every second while this
// layer is up, and the helper stops believing it after a few seconds: however this layer goes away
// (Esc is the app's, not ours), the windows leave picking. Nothing happens where k-float was never used.
const floatDir = () => `${appHome().replace(/[\\/]+$/, "")}${sep()}data${sep()}k-float`;
const floatFile = (name) => `${floatDir()}${sep()}${name}`;
async function floats(on) {
  try {
    if (!(await fs.exists(floatDir()))) return;
    if (on) await fs.writeFile(floatFile("pick"), String(Date.now()));
    else for (const name of ["pick", "picked"]) { try { await fs.unlink(floatFile(name)); } catch {} }
  } catch {}
}

const what = (r) => (r.mod ? `mod=${r.mod}` : r.terminal ? `terminal=${r.terminal}` : r.type === "block" ? "terminal panes (Herdr)" : `type=${r.type}`);

export default class Pick extends View {
  init(p, cx) {
    this.size = null;
    this.pointer = null;
    this.picked = null;
    this.overlays = []; // open dialogs / popups under this layer, bottom first: { name, spec, size }
    this.handle = cx.focus_handle();
    cx.timer.after(50, () => this.handle.focus());
    if (!checking()) {
      cx.spawn(async () => { try { await fs.unlink(floatFile("picked")); } catch {} await floats(true); });
      cx.timer.every(1000, (cx) => { if (!this.picked && !this.leaving) cx.spawn(async () => { await floats(true); }); });
      // A pick made in a k-float window: its helper wrote what the page copied.
      cx.timer.every(400, (cx) => {
        if (this.picked || this.leaving) return;
        cx.spawn(async () => {
          let text = "";
          try { if (await fs.exists(floatFile("picked"))) text = (await fs.readFile(floatFile("picked"), "utf8")) ?? ""; } catch {}
          if (!text.trim() || this.leaving) return;
          notify({ title: "k-pick: copied", body: text.trim(), level: "success", timeout: 6000 });
          this.leave();
        });
      });
    }
    if (!checking()) cx.spawn(async (cx) => {
      await this.loadOverlays();
      // A window overlay draws under dialogs and a click on it closes them: over a dialog, open
      // again as a dialog on top of it (whole window, no frame), which gets the pointer and draws above.
      if (this.dialogOpen() && !props()?.onTop) {
        openOverlay({ mod: "k-pick", kind: "dialog", modal: true, frame: "none", width: 0.9999, height: 0.9999, props: { onTop: true } });
        closeOverlay(props()?.overlay);
        return;
      }
      cx.notify();
    });
    // Over a dialog the pointer's moves don't reach this layer: ask the window where it is.
    cx.timer.every(80, (cx) => {
      if (this.picked || !this.dialogOpen()) return;
      const p = mouseAt();
      if (p && (!this.pointer || p.x !== this.pointer.x || p.y !== this.pointer.y)) { this.pointer = p; cx.notify(); }
    });
  }

  // Which dialogs and popups are open (herdr-app status), and what their mod.json says about size.
  async loadOverlays() {
    let names = [];
    try {
      const r = await exec("herdr-app", ["status"]);
      names = (JSON.parse(r.stdout ?? "{}").overlays ?? []).filter((n) => typeof n === "string" && n !== "k-pick");
    } catch { return; }
    const sizes = shared("k-pick.sizes") ?? {};
    this.overlays = await Promise.all(names.map(async (name) => {
      let spec = null;
      try { spec = JSON.parse((await readTextFile(`${appHome()}${sep()}mods${sep()}${name}${sep()}mod.json`)) ?? "{}").overlay ?? null; } catch {}
      return { name, spec, size: sizes[name] ?? null };
    }));
  }

  // The topmost overlay at a point: { o, rect } (rect null: place unknown, so it may be anywhere).
  overlayAt(x, y) {
    const s = this.size;
    for (const o of [...this.overlays].reverse()) {
      const rect = s ? overlayRect(o, s.width, s.height) : null;
      if (!rect || (x >= rect.x && x < rect.x + rect.w && y >= rect.y && y < rect.y + rect.h)) return { o, rect };
    }
    return null;
  }
  dialogOpen() { return this.overlays.some((o) => (o.spec?.kind ?? "dialog") === "dialog"); }

  blocks() {
    const s = this.size;
    return s ? rects(layout(), 0, 0, s.width, s.height) : [];
  }

  pick(x, y, cx) {
    if (this.picked) return;
    const r = hit(this.blocks(), x, y);
    const ov = this.overlayAt(x, y);
    if (!r && !ov) return;
    this.picked = { r, ov, x, y };
    cx.notify();
    const n = (v) => Math.round(v);
    const loc = (ov ? [
      `layout=${shared("layout") ?? "?"}`,
      `overlay=${ov.o.name}`,
      `kind=${ov.o.spec?.kind ?? "dialog"}`,
      `mod=${ov.o.name}`,
      `file=mods/${ov.o.name}/main.js`,
      ov.rect ? `at=(${n(x)},${n(y)}) in overlay (${n(x - ov.rect.x)},${n(y - ov.rect.y)}) of ${n(ov.rect.w)}×${n(ov.rect.h)}`
        : `at=(${n(x)},${n(y)}) (overlay's place unknown; see the shot)`,
      // Its place unknown, the pick may have been beside it: name the block too.
      !ov.rect && r && `under=${r.id ?? "?"} (${what(r)})`,
    ] : [
      `layout=${shared("layout") ?? "?"}`,
      `block=${r.id ?? "?"}`,
      what(r),
      r.mod && `file=mods/${r.mod}/main.js`,
      `path=${r.path.join(" > ")}`,
      `at=(${n(x)},${n(y)}) in block (${n(x - r.x)},${n(y - r.y)}) of ${n(r.w)}×${n(r.h)}`,
    ]).filter(Boolean).join("  |  ");
    // Let the outline and mark draw, shoot the window with them, then copy and leave.
    cx.timer.after(150, (cx) => cx.spawn(async (cx) => {
      const dir = `${appHome()}${sep()}.k-pick`;
      // Local time in the name (pick-20261121-004340.png), to match the clock people see.
      const d = new Date(), two = (n) => String(n).padStart(2, "0");
      const stamp = `${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
      const shot = `${dir}${sep()}pick-${stamp}.png`;
      let text = loc;
      try {
        // herdr-app shot doesn't make the folder.
        if (window()?.platform === "windows") await exec("powershell.exe", ["-NoProfile", "-Command", `New-Item -ItemType Directory -Force -Path '${dir.replace(/'/g, "''")}' | Out-Null`]);
        else await exec("mkdir", ["-p", dir]);
        const res = await exec("herdr-app", ["shot", shot]);
        if (res.code === 0) text += `  |  shot=${shot}`;
      } catch {}
      cx.write_to_clipboard(text);
      notify({ title: "k-pick: copied", body: text, level: "success", timeout: 6000 });
      this.leave();
    }));
  }

  // Out of picking, here and in k-float's windows.
  leave() {
    if (this.leaving) return;
    this.leaving = true;
    floats(false).finally(() => closeOverlay(props()?.overlay));
  }

  render(_cx) {
    const t = theme();
    const list = this.blocks();
    const at = this.picked ?? (this.pointer && { x: this.pointer.x, y: this.pointer.y, r: hit(list, this.pointer.x, this.pointer.y), ov: this.overlayAt(this.pointer.x, this.pointer.y) });
    // Over an overlay: outline it (when its place is known), labelled with its mod.
    const ov = at?.ov;
    const r = ov ? (ov.rect ? { ...ov.rect, id: ov.o.name, overlay: true } : null) : at?.r;
    const label = ov ? `${ov.o.name} · ${ov.o.spec?.kind ?? "dialog"}${ov.rect ? "" : " (place unknown)"}` : r && `${r.id ?? "?"} · ${what(r)}`;
    const accent = this.picked ? t.done : t.accent;
    const dialog = this.dialogOpen();
    return div().id("k-pick").size_full().relative().cursor_crosshair()
      .track_focus(this.handle)
      .on_size_change((size, cx) => { this.size = size; cx.notify(); })
      .on_mouse_move((e, cx) => { if (!this.picked) { this.pointer = e.position; cx.notify(); } })
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pick(e.position.x, e.position.y, cx); })
      .on_key_down((e, cx) => {
        if (e.key === "escape") { cx.stop_propagation(); this.leave(); return; }
        // Space / Enter: pick at the pointer (the way to pick in a dialog, which a click would close).
        if (e.key === "space" || e.key === "enter") {
          const p = mouseAt() ?? this.pointer;
          if (p) { cx.stop_propagation(); this.pick(p.x, p.y, cx); }
        }
      })
      .when(Boolean(r), (el) => el.child(div().absolute().left(r.x).top(r.y).w(r.w).h(r.h).border_2().border_color(accent).bg(`${accent}22`)))
      .when(Boolean(r), (el) => el.child(div().absolute().left(r.x + 4).top(Math.max(0, r.y + 4)).px(6).py(2).rounded(4).bg(accent).text_color(t.solid_foreground ?? "#ffffff").text_size(11.5)
        .child(label)))
      .when(Boolean(ov && !ov.rect && at), (el) => el.child(div().absolute().left(at.x + 14).top(at.y + 14).px(6).py(2).rounded(4).bg(accent).text_color(t.solid_foreground ?? "#ffffff").text_size(11.5)
        .child(label)))
      .when(Boolean(this.picked), (el) => el.child(div().absolute().left(this.picked.x - 6).top(this.picked.y - 6).size(12).rounded_full().border_2().border_color("#ff3b30").bg("#ff3b3055")))
      .child(h_flex().absolute().top(0).left(0).right(0).h(26).justify_center().items_center().bg(`${t.accent}e6`).text_color(t.solid_foreground ?? "#ffffff").text_size(12)
        .child(this.picked ? "k-pick · 已複製定位器"
          : dialog ? "k-pick · 對話框裡:點一下(或按 Space)複製定位器 · Esc 退出"
            : "k-pick · 點一個區塊(或按 Space)複製定位器 · Esc 退出"));
  }
}

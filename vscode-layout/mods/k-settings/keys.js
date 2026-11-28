// k-settings Keys page (herdr-essentials): every shortcut in keys.json, by section, with search;
// click a key to record a new one (or type it), conflicts in the same section are shown before
// they're replaced; add a shortcut for any command; remove one. Saves keys.json (live in Herdr).
// Without a keys.json, Herdr runs its defaults: the page shows those and the first save writes
// them all out. Once keys.json is edited, Herdr no longer adds new default shortcuts on upgrade.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, InputState, Input } from "gpui-base";
import { appHome, readTextFile, writeTextFile, keys, theme, props, closeOverlay, notify, window } from "herdr";

const PATH = () => `${appHome().replace(/[\\/]+$/, "")}${window()?.platform === "windows" ? "\\" : "/"}keys.json`;
const ORDER = (s) => (s === "global" ? 0 : s === "terminal" ? 1 : s.startsWith("layout:") ? 2 : 3);
const label = (action) => (typeof action === "string" ? action : action?.command ? `${action.command} ${JSON.stringify(action.args ?? {})}` : JSON.stringify(action));

// A key press as keys.json writes it: ctrl-alt-shift-cmd-<key>.
function chord(e) {
  const k = String(e.key ?? "").toLowerCase();
  if (!k || ["shift", "control", "ctrl", "alt", "platform", "cmd", "meta", "super", "function", "fn"].includes(k)) return null;
  const m = e.modifiers ?? {};
  const mac = window()?.platform === "macos";
  return [m.control && "ctrl", m.alt && "alt", m.shift && "shift", m.platform && (mac ? "cmd" : "super"), k].filter(Boolean).join("-");
}

export default class Keys extends View {
  init(p, cx) {
    this.embedded = Boolean(p?.embedded);
    this.text = null;      // keys.json as read (null: none, Herdr's defaults)
    this.map = null;       // { section: { key: action } } being edited
    this.dirty = false;
    this.edit = null;      // { section, key (old, null for new), action, typed } while recording
    this.clash = null;     // { section, key, action, was } waiting for Replace
    this.error = null;
    this.filter = "";
    this.search = InputState.new({ placeholder: "Search keys or commands" });
    this.search.on("change", (_e, cx) => { this.filter = this.search.value().toLowerCase(); cx.notify(); });
    this.keyInput = InputState.new({ placeholder: "e.g. ctrl-f12" });
    this.keyInput.on("submit", (_e, cx) => this.take(this.keyInput.value().trim().toLowerCase(), cx));
    this.actionInput = InputState.new({ placeholder: "command, e.g. mod.open:k-pick" });
    // Typing in a box isn't a key to record.
    this.typing = 0;
    for (const box of [this.search, this.keyInput, this.actionInput]) {
      box.on("focus", () => { this.typing += 1; });
      box.on("blur", () => { this.typing = Math.max(0, this.typing - 1); });
    }
    this.handle = cx.focus_handle();
    cx.spawn(async (cx) => { await this.load(); cx.notify(); });
  }

  async load() {
    this.text = null;
    try { this.text = await readTextFile(PATH()); } catch {}
    let map = null;
    if (this.text != null) { try { map = JSON.parse(this.text); } catch (e) { this.error = `keys.json isn't valid JSON: ${e?.message ?? e}`; } }
    if (!map) {
      map = {};
      for (const b of keys()) (map[b.section] ??= {})[b.keys] = b.action;
    }
    this.map = map;
    this.dirty = false;
  }

  async save(cx) {
    const text = JSON.stringify(this.map, null, 2) + "\n";
    try {
      await writeTextFile(PATH(), text, this.text);
      this.text = text; this.dirty = false;
      notify({ title: "Shortcuts saved", body: "keys.json" });
    } catch (e) { this.error = `Couldn't save keys.json: ${e?.message ?? e} (changed elsewhere? Reload.)`; }
    cx.notify();
  }

  // Start recording a key for a row (key: its current key; null to add).
  begin(section, key, action, cx) {
    this.edit = { section, key, action };
    this.clash = null;
    this.keyInput.set_value("");
    this.handle.focus();
    cx.notify();
  }

  // A new key for the row being edited: clash check, then put.
  take(k, cx) {
    const e = this.edit;
    if (!e || !k) return;
    let action = e.action;
    if (e.key === null) {
      action = this.actionInput.value().trim();
      if (!action) { this.error = "Type the command first (e.g. mod.open:k-pick), then the key."; cx.notify(); return; }
    }
    const was = this.map[e.section]?.[k];
    if (was !== undefined && k !== e.key) { this.clash = { section: e.section, key: k, action, old: e.key, was }; cx.notify(); return; }
    this.put(e.section, e.key, k, action);
    cx.notify();
  }

  put(section, oldKey, key, action) {
    const s = { ...(this.map[section] ?? {}) };
    if (oldKey) delete s[oldKey];
    s[key] = action;
    this.map = { ...this.map, [section]: s };
    this.edit = null; this.clash = null; this.error = null; this.dirty = true;
    this.actionInput.set_value("");
  }

  remove(section, key, cx) {
    const s = { ...(this.map[section] ?? {}) };
    delete s[key];
    this.map = { ...this.map, [section]: s };
    this.dirty = true;
    cx.notify();
  }

  render() {
    const t = theme(), p = props() ?? {};
    const button = (id, text, primary, action, off) => h_flex().id(id).h(28).px(11).items_center().rounded(7).flex_none()
      .border_1().border_color(primary ? t.solid : t.input).bg(primary ? t.solid : t.raised)
      .text_color(primary ? t.solid_foreground : t.foreground).text_size(12)
      .when(Boolean(off), (el) => el.opacity(0.5)).when(!off, (el) => el.cursor_pointer().hover((s) => s.opacity(0.88)).on_click(action)).child(text);
    const chip = (text, on) => div().px(7).h(22).flex().items_center().rounded(5).border_1().border_color(on ? t.accent : t.input).bg(t.raised)
      .text_size(11.5).text_color(on ? t.accent : t.foreground).child(text);

    const recorder = (e) => h_flex().gap(8).items_center().flex_none()
      .child(div().id("k-keys-rec").cursor_pointer().tooltip("Click here, then press the keys")
        .on_click((_e, cx) => { this.handle.focus(); cx.notify(); }).child(chip("Press keys…", true)))
      .child(div().text_size(11).text_color(t.dim).child("or type"))
      .child(Input.new(this.keyInput).w(130).h(24).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
      .child(div().id("k-keys-cancel").text_size(11).text_color(t.dim).cursor_pointer().hover((s) => s.text_color(t.foreground))
        .on_click((_e, cx) => { this.edit = null; this.clash = null; cx.notify(); }).child("Cancel"));

    const row = (section, key, action, i) => {
      const editing = this.edit && this.edit.section === section && this.edit.key === key;
      return h_flex().id(`k-key-${section}-${i}`).min_h(30).px(8).gap(10).items_center().rounded(6).hover((s) => s.bg(t.hover))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).child(label(action)))
        .child(editing ? recorder(this.edit)
          : div().id(`k-key-chip-${section}-${i}`).cursor_pointer().tooltip("Click, then press the new keys")
            .on_click((_e, cx) => this.begin(section, key, action, cx)).child(chip(key, false)))
        .child(div().id(`k-key-rm-${section}-${i}`).size(22).flex().items_center().justify_center().rounded(5).text_color(t.dim)
          .cursor_pointer().tooltip("Remove this shortcut").hover((s) => s.bg(t.hover).text_color(t.blocked))
          .on_click((_e, cx) => this.remove(section, key, cx))
          .child(svg("mods/workspace-chrome/x.svg").size(12)));
    };

    const sections = Object.keys(this.map ?? {}).sort((a, b) => ORDER(a) - ORDER(b) || a.localeCompare(b));
    const f = this.filter;
    const groups = sections.map((s) => ({
      s, rows: Object.entries(this.map[s] ?? {}).filter(([k, a]) => !f || k.includes(f) || label(a).toLowerCase().includes(f)),
    })).filter((g) => g.rows.length || (this.edit?.section === g.s && this.edit.key === null));

    const adding = this.edit && this.edit.key === null;
    const clash = this.clash;
    return v_flex().id("k-keys").track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.key === "escape") {
          if (this.edit || this.clash) { this.edit = null; this.clash = null; cx.notify(); }
          else closeOverlay(p.overlay);
          cx.stop_propagation(); return;
        }
        if (!this.edit || this.clash || this.typing > 0) return;
        const k = chord(e);
        if (!k || k === "enter" || k === "backspace" || k === "tab") return;
        cx.stop_propagation();
        this.take(k, cx);
      })
      .size_full().min_h(0).p(18).gap(10).when(!this.embedded, (el) => el.bg(t.popover)).text_color(t.foreground).text_size(13)
      .child(h_flex().items_center().gap(8)
        .child(div().flex_1().text_size(15).font_semibold().child("Keys"))
        .child(button("k-keys-add", "Add shortcut", false, (_e, cx) => { this.begin("global", null, "", cx); }))
        .child(button("k-keys-save", this.dirty ? "Save" : "Saved", true, (_e, cx) => this.save(cx), !this.dirty)))
      .child(div().text_size(11.5).text_color(t.dim).child(this.text == null
        ? "No keys.json yet: these are Herdr's defaults. Saving writes them all to keys.json, which stops new default shortcuts from being added on upgrades."
        : "keys.json: once edited, new default shortcuts from Herdr upgrades aren't added. Keys Herdr already uses may run instead of being recorded: type those in the box."))
      .when(Boolean(this.error), (el) => el.child(div().text_size(12).text_color(t.blocked).child(this.error)))
      .when(Boolean(clash), (el) => el.child(h_flex().gap(10).items_center().p(8).rounded(7).bg(t.raised).border_1().border_color(t.blocked)
        .child(div().flex_1().text_size(12).child(`${clash.key} already runs “${label(clash.was)}” in ${clash.section}.`))
        .child(button("k-keys-replace", "Replace", true, (_e, cx) => { this.put(clash.section, clash.old, clash.key, clash.action); cx.notify(); }))
        .child(button("k-keys-keep", "Keep it", false, (_e, cx) => { this.clash = null; cx.notify(); }))))
      .when(adding, (el) => el.child(h_flex().gap(10).items_center().p(8).rounded(7).bg(t.raised)
        .child(div().text_size(12).text_color(t.dim).child("global"))
        .child(Input.new(this.actionInput).flex_1().h(26).px(8).rounded(6).border_1().border_color(t.input).bg(t.background).text_size(12).text_color(t.foreground))
        .child(recorder(this.edit))))
      .child(Input.new(this.search).h(30).px(10).rounded(7).border_1().border_color(t.input).bg(t.background).text_size(12.5).text_color(t.foreground))
      .child(v_flex().id("k-keys-list").flex_1().min_h(0).overflow_y_scrollbar()
        .when(this.map === null, (el) => el.child(div().text_color(t.dim).child("Reading keys.json…")))
        .children(groups.map((g) => v_flex().flex_none().pb(10)
          .child(h_flex().px(8).pb(4).gap(6).items_center()
            .child(div().text_size(11).font_semibold().text_color(t.muted).child(g.s))
            .child(div().text_size(10.5).text_color(t.dim).child(String(g.rows.length))))
          .children(g.rows.map(([k, a], i) => row(g.s, k, a, i))))));
  }
}

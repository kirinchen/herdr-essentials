// k-chat (herdr-essentials): the focused Claude Code terminal's conversation as cards.
// Reads the transcript Claude Code writes (~/.claude/projects/<folder>/<session>.jsonl), not
// the screen: the terminal stays for dialogs and / commands; this is for reading, and for
// sending a plain message (`hc send`). Unix machines only (the reads go through `sh`).

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, hc, focused, terminals, theme, settings, checking, nextCommand, notify } from "herdr";
import { Chat, resumeId, fence, usageLine, splitChunk, RESOLVE, READ } from "./transcript.js";

const FIRST = 1_500_000; // bytes read back when a transcript opens
const STEP = 4_000_000; // most bytes one poll reads
const SHOW = 80; // cards drawn at first; "Show earlier" adds more
const MODES = ["md", "html", "raw"];

const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

export default class KChat extends View {
  init(_props, cx) {
    this.address = null; // the terminal shown
    this.info = null; // { file, session, claude, where }
    this.chat = new Chat();
    this.offset = 0;
    this.size = 0;
    this.truncated = false;
    this.error = null;
    this.busy = false;
    this.show = SHOW;
    this.open = new Set(); // expanded tool calls
    this.modes = new Map(); // card key → md | html | raw
    try { this.mode = MODES.includes(localStorage.getItem("mode")) ? localStorage.getItem("mode") : "md"; } catch { this.mode = "md"; }
    this.follow = true;
    this.scroll = ScrollHandle.new();
    this.input = TextareaState.new({ placeholder: "Message (Enter sends, Shift+Enter: new line)" });
    this.input.set_auto_grow(1, 8);
    this.input.on("submit", (e, cx) => {
      // Shift+Enter: the textarea has already put in the new line.
      if (e?.shift) return;
      this.send(cx);
    });
    if (checking()) return;
    cx.spawn(async (cx) => {
      for (;;) {
        const c = await nextCommand();
        if (c === "focus") this.input.focus();
        cx.notify();
      }
    });
    this.ticks = 0;
    cx.timer.every(2000, (cx) => this.tick(cx));
  }

  // The terminal to show: the focused one; while the keyboard is here (a mod pane), the last.
  target() {
    const f = focused();
    const addr = f?.shown ?? f?.terminal ?? f?.agent;
    if (addr) this.lastFocus = addr;
    return this.lastFocus ?? null;
  }

  reset(address) {
    this.address = address;
    this.info = null;
    this.chat = new Chat();
    this.offset = 0;
    this.size = 0;
    this.truncated = false;
    this.error = null;
    this.show = SHOW;
    this.open.clear();
    this.modes.clear();
    this.follow = true;
  }

  tick(cx) {
    if (this.busy) return;
    this.busy = true;
    this.ticks++;
    cx.spawn(async (cx) => {
      // Redraw only when something changed: every redraw is the whole window's.
      const stamp = () => [this.address, this.info?.file, this.info?.claude, this.error, this.chat.version, this.size].join("\u0000");
      const before = stamp();
      try { await this.refresh(); } catch (e) { this.error = String(e?.message ?? e); }
      this.busy = false;
      if (stamp() !== before) cx.notify();
    });
  }

  async refresh() {
    const address = this.target();
    if (address !== this.address) this.reset(address);
    if (!address) return;
    // Which file, again every 10 s: a /clear or /resume moves to another one.
    if (!this.info?.file || this.ticks % 5 === 0) {
      const info = await this.resolve(address);
      if (address !== this.address) return;
      // Another session (or the first look): start over on it.
      if (info.file !== this.info?.file) this.reset(address);
      this.info = info;
      this.error = null;
    }
    if (this.info?.file) await this.read();
  }

  async resolve(address) {
    const r = await hc(["get", address, "--json"]);
    if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim() || `hc get ${address} failed`);
    const t = JSON.parse(r.stdout);
    const fg = t.foreground ?? {};
    const argv = fg.argv ?? t.argv ?? [];
    const claude = /claude/i.test(fg.name ?? "") || argv.slice(0, 2).some((s) => /(^|[\\/])claude(\.exe)?$|claude-code/i.test(String(s))) || t.status?.app === "claude-code";
    const where = t.labels?.where ?? t.title ?? address;
    if (!claude) return { file: null, claude: false, where };
    const out = await exec("sh", ["-c", RESOLVE, "k-chat", String(fg.pid ?? ""), resumeId(argv) ?? "", fg.cwd ?? t.cwd ?? ""], { on: machineOf(address), timeout: 15000 });
    const [session, file] = out.stdout.split("\n");
    return { file: file || null, session: session || null, claude: true, where };
  }

  async read() {
    const file = this.info.file;
    const first = this.size === 0 && this.offset === 0 && this.chat.cards.length === 0;
    const from = first ? -FIRST : this.offset;
    const r = await exec("sh", ["-c", READ, "k-chat", file, String(from), String(STEP)], { on: machineOf(this.address), timeout: 20000 });
    if (file !== this.info?.file) return;
    const nl = r.stdout.indexOf("\n");
    const head = nl < 0 ? r.stdout : r.stdout.slice(0, nl);
    if (head.trim() === "missing") { this.info.file = null; return; }
    const [size, start] = head.split(" ").map(Number);
    if (!first && start !== this.offset) {
      // Shorter than what was read: rewritten. Start over from its end.
      this.chat = new Chat();
      this.offset = 0;
      this.size = 0;
      return;
    }
    this.size = size;
    if (first) { this.offset = start; this.truncated = start > 0; }
    const body = nl < 0 ? "" : r.stdout.slice(nl + 1);
    if (!body) return;
    // Drop the cut first line when reading back from the middle.
    const { lines, used } = splitChunk(body, first && start > 0);
    this.offset += used;
    if (!lines.length) return;
    const before = this.chat.cards.length;
    const lastKey = this.chat.cards.at(-1)?.key;
    this.chat.push(lines);
    if (this.follow && (this.chat.cards.length !== before || this.chat.cards.at(-1)?.key === lastKey)) this.scrollDown();
  }

  scrollDown() {
    // The spacer after the last card: reveals a tall last card's end.
    this.scroll.scroll_to_item(Math.min(this.show, this.chat.cards.length) + (this.hasEarlier() ? 1 : 0));
  }

  hasEarlier() {
    return this.chat.cards.length > this.show || this.truncated;
  }

  send(cx) {
    const text = this.input.value().trim();
    const address = this.address;
    if (!text || !address) return;
    this.input.set_value("");
    this.follow = true;
    cx.spawn(async (cx) => {
      const r = await hc(["send", address, text]);
      if (r.code !== 0) {
        this.input.set_value(text);
        notify({ title: "k-chat: not sent", body: (r.stderr || r.stdout).trim() || `hc send ${address} failed`, level: "error" });
      }
      cx.notify();
    });
  }

  setMode(key, mode) {
    if (key) this.modes.set(key, mode);
    else {
      this.mode = mode;
      this.modes.clear();
      try { localStorage.setItem("mode", mode); } catch {}
    }
  }

  modeButtons(t, key) {
    const on = key ? (this.modes.get(key) ?? this.mode) : this.mode;
    return h_flex().gap(2).flex_none().children(MODES.map((m) => div()
      .id(`mode-${key ?? "all"}-${m}`)
      .px(5)
      .h(16)
      .rounded(4)
      .flex()
      .items_center()
      .text_size(9.5)
      .font_medium()
      .cursor_pointer()
      .text_color(m === on ? t.foreground : t.dim)
      .when(m === on, (el) => el.bg(t.hover))
      .hover((s) => s.text_color(t.foreground))
      .on_click((_e, cx) => { cx.stop_propagation(); this.setMode(key, m); cx.notify(); })
      .child(m.toUpperCase())));
  }

  // One text in the card's mode: markdown, the text as HTML, or as it is.
  text(id, text, mode) {
    if (mode === "html") return TextView.html(id, text).selectable(true);
    if (mode === "raw") return TextView.markdown(id, fence(text)).selectable(true);
    return TextView.markdown(id, text).selectable(true);
  }

  tool(t, card, p, i) {
    const id = `${card.key}-${i}`;
    const open = this.open.has(id);
    const state = p.result == null ? "…" : p.error ? "✗" : "✓";
    const row = h_flex()
      .id(`tool-${id}`)
      .h(22)
      .px(6)
      .gap(6)
      .rounded(5)
      .items_center()
      .text_size(11.5)
      .cursor_pointer()
      .hover((s) => s.bg(t.hover))
      .on_click((_e, cx) => { open ? this.open.delete(id) : this.open.add(id); cx.notify(); })
      .child(svg(`mods/workspace-chrome/chevron-${open ? "down" : "right"}.svg`).size(10).flex_none().text_color(t.dim))
      .child(div().flex_none().font_semibold().text_color(t.muted).child(p.name ?? "tool"))
      .child(div().flex_1().min_w(0).truncate().text_color(t.dim).child(p.summary ?? ""))
      .child(div().flex_none().text_color(p.error ? t.blocked : p.result == null ? t.working : t.dim).child(state));
    if (!open) return row;
    const input = typeof p.input?.command === "string" ? p.input.command : JSON.stringify(p.input ?? {}, null, 2);
    const result = p.result == null ? "(no result yet)" : p.result.length > 6000 ? p.result.slice(0, 6000) + `\n… (${p.result.length - 6000} more characters)` : p.result;
    return v_flex().gap(4)
      .child(row)
      .child(v_flex().ml(16).p(6).gap(6).rounded(6).bg(t.background).border_1().border_color(t.border).text_size(11)
        .child(TextView.markdown(`in-${id}`, fence(input)).selectable(true))
        .child(div().h(1).bg(t.border))
        .child(TextView.markdown(`out-${id}`, fence(result)).selectable(true)));
  }

  card(t, card) {
    if (card.kind === "note") {
      return div().px(10).py(2).text_size(11).text_color(t.dim).truncate().child(card.text.replace(/\s+/g, " "));
    }
    const mode = this.modes.get(card.key) ?? this.mode;
    if (card.kind === "user") {
      return h_flex().w_full().justify_end().pl(40).child(
        v_flex().max_w_full().min_w(0).px(12).py(8).gap(4).rounded(12).bg(t.selected).border_1().border_color(t.border)
          .child(h_flex().gap(6).items_center().text_size(10.5).text_color(t.dim)
            .child(div().font_semibold().child("You"))
            .when(card.images > 0, (el) => el.child(div().child(`🖼 ${card.images}`)))
            .child(div().flex_1())
            .child(this.modeButtons(t, card.key)))
          // What a person typed keeps its line breaks: markdown would join single ones.
          .when(Boolean(card.text), (el) => el.child(this.text(`u-${card.key}`, mode === "md" ? card.text.replace(/([^\n])\n(?=[^\n])/g, "$1  \n") : card.text, mode))));
    }
    const parts = card.parts.map((p, i) => (p.kind === "tool" ? this.tool(t, card, p, i) : this.text(`a-${card.key}-${i}`, p.text, mode)));
    const usage = usageLine(card.usage);
    return h_flex().w_full().pr(24).child(
      v_flex().w_full().min_w(0).px(12).py(8).gap(6).rounded(12).bg(t.surface).border_1().border_color(t.border).shadow_sm()
        .child(h_flex().gap(6).items_center().text_size(10.5).text_color(t.dim)
          .child(div().font_semibold().child("Claude"))
          .when(Boolean(card.model), (el) => el.child(div().child(card.model.replace(/^claude-/, ""))))
          .child(div().flex_1())
          .child(this.modeButtons(t, card.key)))
        .children(parts)
        .when(Boolean(usage), (el) => el.child(div().text_size(10).text_color(t.dim).child(usage))));
  }

  placeholder(t, text) {
    return v_flex().flex_1().items_center().justify_center().p(24).child(div().text_size(12).text_color(t.dim).text_center().child(text));
  }

  render(cx) {
    const t = theme();
    const address = this.address;
    const info = this.info;
    const cards = this.chat.cards;
    const shown = cards.slice(-this.show);
    const earlier = this.hasEarlier();

    const header = h_flex().h(36).px(12).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
      .child(div().text_size(12).font_semibold().text_color(t.foreground).flex_none().child("Chat"))
      .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim)
        .child([this.chat.title, info?.where, address].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ")))
      .when(this.chat.cost?.usd != null, (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(`$${this.chat.cost.usd.toFixed(2)}`)))
      .child(this.modeButtons(t, null));

    let body;
    if (!address) body = this.placeholder(t, "Focus a Claude Code terminal to see its conversation here.");
    else if (this.error && !cards.length) body = this.placeholder(t, `Can't read ${address}: ${this.error}`);
    else if (!info) body = this.placeholder(t, "Looking for the transcript…");
    else if (!info.claude) body = this.placeholder(t, `${address} isn't running Claude Code.`);
    else if (!info.file) body = this.placeholder(t, "No messages yet.");
    else if (!cards.length) body = this.placeholder(t, this.size ? "Reading…" : "No messages yet.");
    else {
      const more = div()
        .id("earlier")
        .py(4)
        .text_size(11)
        .text_center()
        .text_color(t.dim)
        .when(cards.length > this.show, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.show += SHOW; this.follow = false; cx.notify(); }))
        .child(cards.length > this.show
          ? `Show earlier (${cards.length - this.show} more)`
          : `The end of a ${mb(this.size)} transcript: its last ${mb(FIRST)}`);
      body = div().flex_1().min_h(0).relative()
        .child(v_flex()
          .id("cards")
          .size_full()
          .px(10)
          .py(10)
          .gap(10)
          .overflow_y_scrollbar()
          .track_scroll(this.scroll)
          .on_scroll_wheel((e, cx) => {
            // Scrolling up lets go of the bottom; the button below takes you back.
            if ((e.delta?.y ?? 0) > 0 && this.follow) { this.follow = false; cx.notify(); }
          })
          .when(earlier, (el) => el.child(more))
          .children(shown.map((c) => div().id(`card-${c.key}`).w_full().child(this.card(t, c))))
          .child(div().h(1).flex_none()))
        .when(!this.follow, (el) => el.child(div()
          .id("latest")
          .absolute()
          .bottom(10)
          .right(16)
          .px(10)
          .h(24)
          .rounded(12)
          .flex()
          .items_center()
          .bg(t.solid)
          .text_color(t.solid_foreground)
          .text_size(11)
          .cursor_pointer()
          .on_click((_e, cx) => { this.follow = true; this.scrollDown(); cx.notify(); })
          .child("↓ Latest")));
    }

    const composer = h_flex().p(8).gap(8).flex_none().items_end().border_t(1).border_color(t.border)
      .child(div().flex_1().min_w(0).rounded(8).border_1().border_color(t.input).bg(t.background).px(8).py(6).text_size(13)
        .child(Textarea.new(this.input)))
      .child(div()
        .id("send")
        .h(30)
        .px(12)
        .rounded(8)
        .flex()
        .items_center()
        .text_size(12)
        .font_medium()
        .when(Boolean(address), (el) => el.bg(t.solid).text_color(t.solid_foreground).cursor_pointer().on_click((_e, cx) => this.send(cx)))
        .when(!address, (el) => el.bg(t.hover).text_color(t.dim))
        .child("Send"));

    return v_flex().size_full().min_h(0).bg(t.canvas ?? t.chrome).text_color(t.foreground).text_size(13)
      .child(header)
      .child(body)
      .child(composer);
  }
}

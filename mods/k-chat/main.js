// k-chat (herdr-essentials): a Claude Code terminal's conversation as cards, one per message,
// shown in the terminal's place (k-tabs' Cards | Terminal switch puts it there).
// Reads the transcript Claude Code writes (~/.claude/projects/<folder>/<session>.jsonl), not
// the screen. Dialogs (permissions, choices) and / commands stay in the terminal: switch back
// for those. Reads go through `sh`, or PowerShell when the terminal's machine is Windows.

import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, ScrollHandle, TextareaState, Textarea, TextView } from "gpui-base";
import { exec, hc, home, focused, panes, terminals, layout, run, theme, checking, nextCommand, notify, window } from "herdr";
import { Chat, resumeId, fence, splitChunk, RESOLVE, READ, resolvePs, readPs, powershell, windowsPath } from "./transcript.js";

const FIRST = 1_500_000; // bytes read back when a transcript opens
const STEP = 4_000_000; // most bytes one poll reads
const SHOW = 80; // cards drawn at first; "Show earlier" adds more
const STACK = "k-chat-stack"; // k-tabs' stack: the terminal block and this one (see k-tabs/chat.js)
const CARDS = "k-chat-cards";

const machineOf = (address) => (address?.includes("/") ? address.split("/")[0] : null);
const mb = (n) => `${(n / 1e6).toFixed(1)} MB`;

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

// Today: 00:12:03. Before: 11/21 23:55.
function when(at) {
  if (!at) return "";
  const d = new Date(at);
  if (Number.isNaN(d.getTime())) return "";
  const p = (n) => String(n).padStart(2, "0");
  const time = `${p(d.getHours())}:${p(d.getMinutes())}`;
  return d.toDateString() === new Date().toDateString() ? `${time}:${p(d.getSeconds())}` : `${d.getMonth() + 1}/${d.getDate()} ${time}`;
}

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
    this.copied = null;
    this.follow = true;
    this.me = String(home() ?? "").split(/[\\/]/).filter(Boolean).pop() || "you";
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
        // Shown again (k-tabs' Cards): to the latest, and the keyboard to the message box.
        if (c === "focus") { this.input.focus(); if (this.follow) this.scrollDown(); }
        cx.notify();
      }
    });
    this.ticks = 0;
    cx.timer.every(2000, (cx) => this.tick(cx));
  }

  // The terminal to show: the focused one; while the keyboard is here, the shown tab's
  // focused terminal (else its agent, else its first terminal).
  target() {
    const f = focused();
    const direct = f?.shown ?? f?.terminal;
    if (direct) return (this.lastFocus = direct);
    if (f?.tab) {
      const inTab = panes().filter((p) => p.tab === f.tab && p.terminal);
      const p = inTab.find((p) => p.focused) ?? inTab.find((p) => p.program?.agent) ?? inTab[0];
      if (p) return (this.lastFocus = p.terminal);
    }
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
    // The terminal's machine, not this window's, decides: a Windows path, or this machine is Windows.
    const cwd = fg.cwd ?? t.cwd ?? "";
    const on = machineOf(address);
    const windows = windowsPath(cwd) || (!on && !cwd && window()?.platform === "windows");
    const args = [String(fg.pid ?? ""), resumeId(argv) ?? "", cwd];
    const out = await (windows ? exec("powershell.exe", powershell(resolvePs(...args)), { on, timeout: 15000 }) : exec("sh", ["-c", RESOLVE, "k-chat", ...args], { on, timeout: 15000 }));
    const [session, file] = out.stdout.replace(/\r/g, "").split("\n");
    return { file: file || null, session: session || null, claude: true, where, windows };
  }

  async read() {
    const file = this.info.file;
    const first = this.size === 0 && this.offset === 0 && this.chat.cards.length === 0;
    const from = first ? -FIRST : this.offset;
    const on = machineOf(this.address);
    const r = await (this.info.windows ? exec("powershell.exe", powershell(readPs(file, from, STEP)), { on, timeout: 20000 }) : exec("sh", ["-c", READ, "k-chat", file, String(from), String(STEP)], { on, timeout: 20000 }));
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
    this.chat.push(lines);
    if (this.follow) this.scrollDown();
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

  // Back to the terminal (k-tabs' stack), or null when this copy isn't in one.
  terminalChild() {
    const stack = find(layout(), STACK);
    return stack?.children?.find((c) => c.id !== CARDS)?.id ?? null;
  }

  toTerminal() {
    const child = this.terminalChild();
    if (child) run("layout.select", { stack: STACK, child });
    if (this.address) run("pane.focus", { terminal: this.address });
  }

  copy(cx, key, text) {
    cx.write_to_clipboard(text);
    this.copied = key;
    cx.notify();
    cx.timer.after(1500, (cx) => { if (this.copied === key) { this.copied = null; cx.notify(); } });
  }

  tool(t, card, p, i) {
    const id = `${card.key}-${i}`;
    const open = this.open.has(id);
    const state = p.result == null ? "…" : p.error ? "✗" : "✓";
    const row = h_flex()
      .id(`tool-${id}`)
      .h(24)
      .px(6)
      .gap(6)
      .rounded(6)
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
      .child(v_flex().ml(16).gap(4).text_size(11)
        .child(TextView.markdown(`in-${id}`, fence(input)).selectable(true))
        .child(TextView.markdown(`out-${id}`, fence(result)).selectable(true)));
  }

  // One message, as a Tide comment: who and when on top, the text under it.
  card(t, card) {
    if (card.kind === "note") {
      return h_flex().px(4).gap(8).text_size(11).text_color(t.dim)
        .child(div().flex_none().child(when(card.at)))
        .child(div().flex_1().min_w(0).truncate().child(card.text.replace(/\s+/g, " ")));
    }
    const mine = card.kind === "user";
    const text = mine ? card.text : card.parts.filter((p) => p.kind === "text").map((p) => p.text).join("\n\n");
    const body = mine
      // What a person typed keeps its line breaks: markdown would join single ones.
      ? (card.text ? [TextView.markdown(`u-${card.key}`, card.text.replace(/([^\n])\n(?=[^\n])/g, "$1  \n")).selectable(true)] : [])
      : card.parts.map((p, i) => (p.kind === "tool" ? this.tool(t, card, p, i) : TextView.markdown(`a-${card.key}-${i}`, p.text).selectable(true)));
    const copied = this.copied === card.key;
    return v_flex().w_full().px(11).py(9).gap(6).rounded(8).bg(t.surface).border_1().border_color(t.border).text_size(12.5)
      .child(h_flex().gap(8).items_center().text_size(11.5)
        .child(div().flex_none().font_semibold().text_color(t.accent).child(`@${mine ? this.me : "claude"}`))
        .child(div().flex_none().text_color(t.dim).child(when(card.at)))
        .when(!mine && Boolean(card.model), (el) => el.child(div().flex_none().text_size(10.5).text_color(t.dim).child(card.model.replace(/^claude-/, ""))))
        .when(mine && card.images > 0, (el) => el.child(div().flex_none().text_color(t.dim).child(`🖼 ${card.images}`)))
        .child(div().flex_1())
        .when(Boolean(text), (el) => el.child(div()
          .id(`copy-${card.key}`)
          .px(3)
          .rounded(4)
          .text_size(11)
          .cursor_pointer()
          .text_color(copied ? t.accent : t.dim)
          .hover((s) => s.text_color(t.accent))
          .tooltip("Copy this message")
          .on_click((_e, cx) => this.copy(cx, card.key, text))
          .child(copied ? "✓ Copied" : "Copy"))))
      .children(body);
  }

  placeholder(t, text) {
    return v_flex().flex_1().min_h(0).items_center().justify_center().p(24).child(div().text_size(12).text_color(t.dim).text_center().child(text));
  }

  render(cx) {
    const t = theme();
    const address = this.address;
    const info = this.info;
    const cards = this.chat.cards;
    const shown = cards.slice(-this.show);
    const earlier = this.hasEarlier();
    const live = address ? terminals().find((x) => x.address === address) : null;
    const blocked = live?.status === "blocked";
    const back = this.terminalChild();

    const header = h_flex().h(38).px(12).gap(8).flex_none().items_center().border_b(1).border_color(t.border)
      .child(div().flex_none().text_size(12).font_semibold().text_color(t.foreground).child("💬"))
      .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.muted)
        .child([this.chat.title, info?.where, address].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(" · ") || "Chat"))
      .when(this.chat.cost?.usd != null, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(`$${this.chat.cost.usd.toFixed(2)}`)))
      .when(cards.length > 0, (el) => el.child(div().flex_none().text_size(11).text_color(t.dim).child(String(cards.length))))
      .when(Boolean(back), (el) => el.child(div()
        .id("to-terminal")
        .h(24)
        .px(8)
        .flex()
        .items_center()
        .rounded(6)
        .border(1)
        .border_color(t.border)
        .text_size(11.5)
        .text_color(t.muted)
        .cursor_pointer()
        .hover((s) => s.text_color(t.foreground).bg(t.hover))
        .tooltip("Show the terminal")
        .on_click(() => this.toTerminal())
        .child("Terminal")));

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
        .py(5)
        .px(9)
        .rounded(8)
        .border(1)
        .border_dashed()
        .border_color(t.border)
        .text_size(11.5)
        .text_color(t.dim)
        .when(cards.length > this.show, (el) => el.cursor_pointer().hover((s) => s.text_color(t.foreground))
          .on_click((_e, cx) => { this.show += SHOW; this.follow = false; cx.notify(); }))
        .child(cards.length > this.show
          ? `⌃ Show earlier (${cards.length - this.show} more)`
          : `The end of a ${mb(this.size)} transcript: its last ${mb(FIRST)}`);
      body = div().flex_1().min_h(0).relative()
        .child(v_flex()
          .id("cards")
          .size_full()
          .p(12)
          .gap(10)
          .overflow_y_scrollbar()
          .track_scroll(this.scroll)
          .on_scroll_wheel((e, cx) => {
            // Scrolling up lets go of the bottom; the button below takes you back.
            if ((e.delta?.y ?? 0) > 0 && this.follow) { this.follow = false; cx.notify(); }
          })
          .when(earlier, (el) => el.child(more))
          .children(shown.map((c) => div().id(`card-${c.key}`).w_full().flex_none().child(this.card(t, c))))
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

    // Claude is asking something only the terminal can answer (a permission, a choice).
    const ask = div()
      .id("blocked")
      .mx(12)
      .mb(8)
      .px(10)
      .py(6)
      .rounded(8)
      .border(1)
      .border_color(t.blocked)
      .bg(t.blocked + "1a")
      .text_size(12)
      .text_color(t.foreground)
      .when(Boolean(back), (el) => el.cursor_pointer().on_click(() => this.toTerminal()))
      .child(back ? "Claude is waiting for you in the terminal (a permission or a choice). Click to answer it there." : "Claude is waiting for you in the terminal (a permission or a choice).");

    const composer = v_flex().pt(10).flex_none().border_t(1).border_color(t.border).bg(t.surface)
      .when(blocked, (el) => el.child(ask))
      .child(h_flex().px(12).pb(12).gap(8).items_end()
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
          .child("Send")));

    return v_flex().size_full().min_h(0).bg(t.canvas ?? t.chrome).text_color(t.foreground).text_size(13)
      .child(header)
      .child(body)
      .child(composer);
  }
}

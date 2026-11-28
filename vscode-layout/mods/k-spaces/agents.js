// k-spaces (herdr-essentials): the menu behind a space row's "+": a new tab in that space, a plain
// terminal or an agent (the shipped new-menu's list: knownAgents() on the space's machine), with a
// YOLO switch that starts the agent with its skip-every-permission flag. The switch is remembered.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, spaces, knownAgents, run, closeOverlay, props, shared, setShared, exec, appHome } from "herdr";
import { system } from "./inspect.js";
import { check, there } from "./has.js";
import { kindOf, list as sessions, resumeArgs, ago } from "./sessions.js";

// The last agents each machine reported (the shipped new-menu's cache), shown while checking again.
const KNOWN = "new-menu.agents";
const YOLO_KEY = "k-spaces.yolo";

// Each agent's "don't ask me anything" flag, by its key or its program's name.
const YOLO = {
  claude: ["--dangerously-skip-permissions"],
  agy: ["--dangerously-skip-permissions"],
  antigravity: ["--dangerously-skip-permissions"],
  codex: ["--dangerously-bypass-approvals-and-sandbox"],
  gemini: ["--yolo"],
  qwen: ["--yolo"],
};
export function yoloFlags(agent) {
  const prog = String(agent?.run?.[0] ?? "").split(/[\\/]/).pop().replace(/\.(exe|cmd|bat|ps1)$/i, "").toLowerCase();
  return YOLO[String(agent?.key ?? "").toLowerCase()] ?? YOLO[prog] ?? null;
}

export default class AgentMenu extends View {
  init(p, cx) {
    this.spaceId = p?.space ?? null;
    this.machine = p?.machine ?? null;
    const where = this.machine ?? "";
    this.agents = shared(KNOWN)?.[where] ?? [];
    this.failed = false;
    this.yolo = shared(YOLO_KEY) === true;
    this.handle = cx.focus_handle();
    cx.timer.after(30, () => this.handle.focus());
    cx.spawn(async (cx) => { await check(["k-chat"]); cx.notify(); });
    cx.spawn(async (cx) => {
      try {
        this.agents = await knownAgents({ on: this.machine });
        setShared(KNOWN, { ...shared(KNOWN), [where]: this.agents });
      } catch { this.failed = true; }
      cx.notify();
    });
  }

  close() { const id = props()?.overlay; if (id) closeOverlay(id); }

  // `session`: go on with that one (Claude Code's --resume) instead of a new one.
  start(agent, session = null) {
    const flags = this.yolo ? yoloFlags(agent) : null;
    // Its own flags first: Codex's "resume <id>" is a subcommand, and flags after it are that subcommand's.
    run("tab.new", { name: agent.name, space: this.spaceId, argv: [...agent.run, ...(flags ?? []), ...(session ? resumeArgs(session, kindOf(agent)) : [])] });
    this.close();
  }

  // An agent whose sessions can be read (Claude Code, Codex, agy; sessions.js): when it had some in this space's folder, list
  // them with New below; none (or the check fails) → a new one right away, as before.
  pick(agent, cx) {
    const space = spaces().find((s) => s.id === this.spaceId);
    const kind = kindOf(agent);
    if (!kind || !space?.folder) { this.start(agent); return; }
    if (this.checking) return;
    this.checking = agent.key; cx.notify();
    cx.spawn(async (cx) => {
      let found = [];
      try { found = await sessions(exec, { folder: space.folder, machine: this.machine, kind, posix: kind === "claude" ? (await system(this.machine)).posix : true }); } catch {}
      this.checking = null;
      if (!found.length) { this.start(agent); return; }
      this.picking = { agent, sessions: found };
      cx.notify();
    });
  }

  // Chat: a plain conversation with this space's agent (k-chat, no chair), kept in the space's
  // doc/chat/. Made and hosted by k-chat's runner; its tab is the k-chat mod on that state file.
  chat(cx) {
    const space = spaces().find((s) => s.id === this.spaceId);
    if (!space?.folder || this.busy) return;
    this.busy = true; this.error = null; cx.notify();
    cx.spawn(async (cx) => {
      try {
        const runner = `${appHome().replace(/[\\/]+$/, "")}/tools/k-chat/runner.mjs`;
        const d = new Date(), two = (n) => String(n).padStart(2, "0");
        const stamp = `${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`;
        const title = `Chat ${stamp}`, topic = `chat-${d.getFullYear()}${two(d.getMonth() + 1)}${two(d.getDate())}-${two(d.getHours())}${two(d.getMinutes())}${two(d.getSeconds())}`;
        const member = { name: space.name, space: space.name, cwd: space.folder, agent: "claude" };
        const made = await exec("node", [runner, "new", "--direct", "--repo", space.folder, "--topic", topic, "--title", title, "--space", space.name, "--members", JSON.stringify([member])], { timeout: 20000 });
        if (made.code !== 0) throw new Error((made.stderr || made.stdout || "runner failed").trim().split("\n").pop());
        const state = made.stdout.trim();
        await exec("node", [runner, "start", state, "--no-layout"], { timeout: 20000 });
        run("tab.new", { space: space.id, name: `💬 ${title}`.slice(0, 40), mod: "k-chat", props: { state, space: space.id } });
        this.close();
      } catch (e) { this.error = String(e?.message ?? e).slice(0, 120); this.busy = false; cx.notify(); }
    });
  }

  row(t, id, icon, name, action, hint = "", enabled = true) {
    return h_flex().id(id).h(31).px(9).gap(10).rounded(7).items_center().flex_none()
      .text_color(enabled ? t.foreground : t.dim).when(enabled, (el) => el.cursor_pointer().hover((s) => s.bg(t.selected)))
      .on_click((_e, cx) => { if (enabled) action(cx); })
      .child(icon).child(div().flex_1().min_w(0).truncate().child(name)).child(div().flex_none().text_size(11).text_color(t.dim).child(hint));
  }

  render() {
    const t = theme();
    const space = spaces().find((s) => s.id === this.spaceId);
    if (this.picking) {
      const { agent, sessions: found } = this.picking, flags = this.yolo && yoloFlags(agent);
      return v_flex().id("k-agent-sessions").w_full().h(Math.min(400, 80 + found.length * 31)).min_h(0).bg(t.popover).p(5).text_size(12.8).text_color(t.foreground)
        .track_focus(this.handle)
        .on_key_down((e, cx) => { if (e.key === "escape" || e.key === "backspace") { this.picking = null; cx.notify(); } else if (e.key === "n" || e.key === "enter") this.start(agent); })
        .child(h_flex().px(4).pt(2).pb(4).gap(6).items_center().text_size(11).text_color(t.dim)
          .child(div().id("k-agent-back").px(5).rounded(4).cursor_pointer().hover((s) => s.bg(t.hover)).on_click((_e, cx) => { this.picking = null; cx.notify(); }).child("←"))
          .child(div().flex_1().min_w(0).truncate().child(`${agent.name}${flags ? " · YOLO" : ""} · sessions in ${space?.name ?? "this space"}`)))
        .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
          .children(found.map((s, i) => this.row(t, `k-agent-session-${i}`, svg("mods/k-spaces/bot.svg").size(14).text_color(t.muted),
            s.title || s.prompt, () => this.start(agent, s.id), ago(s.at)).tooltip(s.title && s.prompt ? `${s.title}\n› ${s.prompt.slice(0, 200)}` : s.prompt.slice(0, 200) || s.id))))
        .child(div().h(1).my(3).flex_none().bg(t.border))
        .child(this.row(t, "k-agent-session-new", div().w(14).flex_none().text_center().child("+"), "New", () => this.start(agent), "N"));
    }
    const installed = this.agents.filter((a) => a.installed);
    const choices = this.failed ? installed : [...installed, ...this.agents.filter((a) => !a.installed).slice(0, 2)];
    const toggle = () => { this.yolo = !this.yolo; setShared(YOLO_KEY, this.yolo); };
    // A popup sizes to its content: give the list room for its rows (as the shipped new-menu does).
    const rows = Math.max(1, choices.length + (this.failed || this.agents.length === 0 ? 1 : 0));
    return v_flex().id("k-agent-menu").w_full().h(Math.min(400, 139 + rows * 31)).min_h(0).bg(t.popover).p(5).text_size(12.8).text_color(t.foreground)
      .track_focus(this.handle)
      .on_key_down((e, cx) => {
        if (e.modifiers.control || e.modifiers.platform || e.modifiers.alt) return;
        if (e.key === "y") { toggle(); cx.notify(); return; }
        const agent = /^[1-9]$/.test(e.key) ? installed[Number(e.key) - 1] : null;
        if (agent) this.pick(agent, cx);
      })
      .child(div().px(9).pt(4).pb(4).text_size(11).text_color(t.dim).truncate().child(`New tab in ${space?.name ?? "this space"}${this.machine ? ` · ${this.machine}` : ""}`))
      .child(this.row(t, "k-agent-terminal", svg("icons/shell.svg").size(14), "Terminal", () => { run("tab.new", { space: this.spaceId }); this.close(); }))
      // Its record is written on this machine, into the space's folder: not for a space on another machine.
      .when(there("k-chat"), (el) => el.child(this.row(t, "k-agent-chat", svg("mods/k-spaces/bot.svg").size(14).text_color(t.foreground), this.busy ? "Starting chat…" : "Chat", (cx) => this.chat(cx),
        this.error ?? (this.machine ? "this machine only" : "saved in doc/chat"), !this.machine && !this.busy && Boolean(space?.folder))))
      .child(h_flex().px(9).pt(8).pb(4).items_center()
        .child(div().flex_1().text_size(11).text_color(t.dim).child("Start an agent"))
        // YOLO: the agent asks nothing (its skip-permissions flag); Y toggles it too.
        .child(h_flex().id("k-agent-yolo").gap(6).px(6).h(22).rounded(5).items_center().cursor_pointer()
          .text_size(11).text_color(this.yolo ? t.blocked : t.dim).hover((s) => s.bg(t.hover))
          .tooltip("Start the agent without permission prompts (Y)")
          .on_click((_e, cx) => { toggle(); cx.notify(); })
          .child(div().w(26).h(14).rounded(7).p(2).flex().items_center().bg(this.yolo ? t.blocked : t.border)
            .when(this.yolo, (el) => el.justify_end())
            .child(div().size(10).rounded(5).bg("#ffffff")))
          .child("YOLO")))
      .child(v_flex().flex_1().min_h(0).overflow_y_scrollbar()
        .children(choices.map((a, i) => {
          const flags = yoloFlags(a);
          const hint = !a.installed ? "not installed" : this.yolo && !flags ? "no YOLO flag" : i < 9 ? String(i + 1) : "";
          return this.row(t, `k-agent-${a.key}`, a.tint ? svg(a.icon).size(14).text_color(t.foreground) : image(a.icon).size(14),
            this.checking === a.key ? `${a.name} · checking sessions…` : this.yolo && flags && a.installed ? `${a.name} · YOLO` : a.name, (cx) => this.pick(a, cx), hint, a.installed);
        }))
        .when(this.failed || this.agents.length === 0, (el) => el.child(div().px(9).py(6).text_color(t.dim)
          .child(this.failed ? "Could not check installed agents" : "Checking installed agents…"))));
  }
}

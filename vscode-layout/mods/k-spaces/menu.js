// k-spaces (herdr-essentials): the sidebar's right-click menus, in place of the shipped `menu` for
// spaces, plus ones for a fold-out tab row and a machine header:
//   tab:     Copy path, Copy address, Rename, New tab, Close
//   space:   Rename, worktree items, Copy name, Copy path, MCP & Skills (inspect.js), Hide / Unhide, Close
//   machine: Agents (inspect.js), Hide / Unhide (its spaces go with it)
// Hidden spaces and machines are per window (shared.json lives in each profile's App home): see
// hidden() in main.js. ↑/↓ move, Enter runs, Esc closes, as in the shipped menu.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, keys, notify, shared, setShared } from "herdr";
import { openAgentsInfo, openProjectInfo } from "./inspect.js";
import { check, there } from "./has.js";

export const HIDDEN = "k-spaces.hidden";
// { machines: ["" (this computer) | name], spaces: [id] }
export function hidden() {
  const h = shared(HIDDEN);
  return { machines: Array.isArray(h?.machines) ? h.machines : [], spaces: Array.isArray(h?.spaces) ? h.spaces : [] };
}
export function setHidden(kind, key, hide) {
  const h = hidden();
  const list = h[kind].filter((k) => k !== key);
  if (hide) list.push(key);
  setShared(HIDDEN, { ...h, [kind]: list });
}

const copy = (cx, text, what) => { cx.write_to_clipboard(text); notify({ title: `Copied ${what}`, body: text }); };

// An item: { label, icon, act(cx), hint?, rule? (a line above it) }.
function items(p) {
  const tg = p.target ?? {};
  const icon = (n) => `mods/workspace-chrome/${n}.svg`;
  switch (p.kMenu) {
    case "tab":
      return [
        ...(tg.path ? [{ label: "Copy path", icon: "mods/k-spaces/copy.svg", hint: tg.path, act: (cx) => copy(cx, tg.path, "path") }] : []),
        ...(tg.terminal ? [{ label: "Copy address", icon: "mods/k-spaces/copy.svg", hint: tg.terminal, act: (cx) => copy(cx, tg.terminal, "address") }] : []),
        { label: "Rename", icon: icon("square-pen"), command: "tab.rename", act: () => run("tab.rename", { id: tg.id }), rule: Boolean(tg.path || tg.terminal) },
        { label: "New tab", icon: icon("plus"), command: "tab.new", act: () => run("tab.new", { space: tg.space }) },
        { label: "Close", icon: icon("x"), command: "tab.close", act: () => run("tab.close", { id: tg.id }), rule: true },
      ];
    case "space": {
      const wt = (action, size) => () => openOverlay({ mod: "worktree", kind: "dialog", ...size, props: { space: tg.id, action } });
      return [
        { label: "Rename", icon: icon("square-pen"), command: "space.rename", act: () => run("space.rename", { id: tg.id }) },
        ...(tg.git ? [
          { label: "New worktree", icon: icon("git-branch"), act: wt("new", { width: 440, height: 260 }) },
          { label: "Open worktree", icon: icon("git-branch"), act: wt("open", { width: 560, height: 480 }) },
        ] : []),
        ...(tg.git === "linked" ? [{ label: "Remove worktree", icon: icon("git-branch"), act: wt("remove", { width: 440, height: 260 }) }] : []),
        ...(tg.name ? [{ label: "Copy name", icon: "mods/k-spaces/copy.svg", hint: tg.name, act: (cx) => copy(cx, tg.name, "name"), rule: true }] : []),
        ...(tg.path ? [{ label: "Copy path", icon: "mods/k-spaces/copy.svg", hint: tg.path, act: (cx) => copy(cx, tg.path, "path"), rule: !tg.name }] : []),
        { label: "MCP & Skills", icon: "mods/k-spaces/plug.svg", hint: "this folder", act: () => openProjectInfo(openOverlay, tg), rule: true },
        // k-chat: a discussion among agents, kept in this Space's doc/chat/ (this Space is the main one).
        ...(there("k-chat") ? [{ label: "Discussion", icon: "mods/k-spaces/bot.svg", hint: "k-chat", act: () => openOverlay({ mod: "k-chat", kind: "window", key: "k-chat", width: 780, height: 0.86, props: { space: tg.id } }) }] : []),
        tg.hidden
          ? { label: "Unhide space", icon: "mods/k-spaces/eye.svg", act: () => setHidden("spaces", tg.id, false) }
          : { label: "Hide space", icon: "mods/k-spaces/eye-off.svg", hint: "this window", act: () => setHidden("spaces", tg.id, true) },
        { label: "Close", icon: icon("x"), command: "space.close", act: () => run("space.close", { id: tg.id }), rule: true },
      ];
    }
    case "machine":
      return [{ label: "Agents", icon: "mods/k-spaces/bot.svg", hint: "MCP, skills, status", act: () => openAgentsInfo(openOverlay, tg.key || null) }, tg.hidden
        ? { label: `Unhide ${tg.name}`, icon: "mods/k-spaces/eye.svg", act: () => setHidden("machines", tg.key, false) }
        : { label: `Hide ${tg.name}`, icon: "mods/k-spaces/eye-off.svg", hint: "this window", act: () => setHidden("machines", tg.key, true) }];
    default:
      return [];
  }
}

const shortcut = (name) => (name ? keys().find((b) => b.section === "global" && b.action === name)?.keys ?? "" : "");

export default class KMenu extends View {
  init(_p, cx) {
    cx.spawn(async (cx) => { await check(["k-chat"]); cx.notify(); });
    this.at = 0;
    this.handle = cx.focus_handle();
    cx.timer.after(20, () => this.handle.focus());
  }

  choose(i, cx) {
    const it = items(props())[i];
    if (!it) return;
    const id = props()?.overlay;
    it.act(cx);
    closeOverlay(id);
  }

  render() {
    const t = theme();
    const list = items(props());
    return v_flex().id("k-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") return this.choose(this.at, cx);
        else if (e.key === "escape") return closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => v_flex()
        .when(i > 0 && Boolean(it.rule), (el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`k-mi-${i}`).h(31).px(8).gap(9).rounded(7).items_center().text_color(t.foreground)
          .when(i === this.at, (el) => el.bg(t.selected))
          .hover((s) => s.bg(t.hover))
          .on_click((_e, cx) => this.choose(i, cx))
          .child(svg(it.icon).size(14).flex_none().text_color(t.muted))
          .child(div().flex_none().child(it.label))
          .child(div().flex_1().min_w(0).truncate().text_right().text_size(11).text_color(t.dim).child(it.hint ?? shortcut(it.command))))));
  }
}
